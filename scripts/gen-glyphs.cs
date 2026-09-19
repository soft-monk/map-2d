// mission-app · map-2d · scripts/gen-glyphs.cs
//
// **离线字形生成器**：把本机字体栅格化成 MapLibre 的 glyph PBF（SDF）。
//
// 为什么只需要生成"非表意字符"这几段：
//   MapLibre 的 `GlyphManager._doesCharSupportLocalGlyph` 是这么判的（见 maplibre-gl 源码）：
//       return !!this.localIdeographFontFamily &&
//         /\p{Ideo}|\p{sc=Hang}|\p{sc=Hira}|\p{sc=Kana}/u.test(String.fromCodePoint(id));
//   也就是说 **汉字/假名/韩文** 会走 `TinySDF` 在浏览器里**用本机字体实时生成**，
//   压根不请求 PBF。真正需要 PBF 的是：
//       · ASCII 与 Latin-1（数字、字母、·）
//       · 常用标点（—、…、“”、）
//       · CJK 标点（、。「」【】）
//       · 全角形式（（）、！？：；）
//   这几段加起来不到 1000 个码位 —— 于是**不需要**生成两万个汉字、也不需要十几 MB 字体文件。
//
// 编码格式（**逐字段照 MapLibre 的 reader 抄，不凭记忆**）：
//   Glyphs    { repeated Fontstack stacks = 1 }
//   Fontstack { string name = 1; string range = 2; repeated Glyph glyphs = 3 }
//   Glyph     { uint32 id = 1; bytes bitmap = 2; uint32 width = 3; uint32 height = 4;
//               sint32 left = 5; sint32 top = 6; uint32 advance = 7 }
//   · `id` 是**绝对码位**（reader 里 `glyphs[glyph.id] = glyph`，查表用的就是绝对码位）
//   · `bitmap` 的字节数 = `(width + 6) * (height + 6)` —— reader 会把 width/height **各加 3px 边**
//     自己拼 AlphaImage（`width + 2 * border`，`border = 3`），所以 PBF 里的 width/height 是
//     **去掉这 3px 边之后的紧致尺寸**，而 bitmap 必须已经含边。
//   · SDF：边缘在 0.5（127.5），半径 8px —— 与 MapLibre 着色器里的 `SDF_PX = 8` 对齐。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Text;

public static class GlyphGen
{
    const int EM = 24;          // 字号（px），与 MapLibre TinySDF 的 fontSize 一致
    const int BORDER = 3;       // MapLibre 的 GLYPH_PBF_BORDER
    // SDF 半径：**2**。轮廓位置由 EDGE 决定（见下），半径只决定"梯度有多陡"：
    // 半径越小 → 同样的阈值差对应更窄的过渡带 → 边缘越锐。8 那版"发糊"，4 仍偏软，故收到 2。
    const int RADIUS = 2;
    // **边缘值 0.95** —— 这一个数同时管两件事，是本生成器最重要的旋钮：
    //   · 字形胖瘦：着色器实际阈值实测在 0.75 附近（= 字形几何边缘）。
    //     给 0.75 → 笔画就是原始粗细（需求方反馈"糊/细"）；
    //     给 0.95 → 轮廓外移 (0.95−0.75)×RADIUS = 0.4px/边 ≈ **笔画 +0.8px**（"半粗"，实测不粘连）；
    //     给 0.65 → 反向内缩，字形被削成"骨架"。
    //   · 填充能不能画出来：值太低（如 0.5）时笔画内部的 SDF 值过不了阈值，
    //     **填充那一遍整遍不画**，只剩描边（观感是"黑字"）。
    const float EDGE = 0.95f;

    /// <summary>生成一批 range（起点必须是 256 的整数倍）</summary>
    /// <param name="cjkWhitelist">
    /// **要造的汉字白名单**（2026-09-18 新增，可为 null）。
    ///
    /// 为什么要它：汉字有两万多个，全造约 13 MB。而 `MAP_OPTIONS.localIdeographFontFamily`
    /// 一旦开着，MapLibre 对**所有**表意文字都走"浏览器本机实时生成"，PBF 里的汉字**根本不会被用**；
    /// 而两条字形来源（汉字本地生成 / 拉丁走 PBF）混在一段文字里时，渲染器会把它们**排成两块**
    /// （实测：「光电 opt-005」被拆成中文一块、字母一块，见 `参考文档` 里记的那次排查）。
    /// 所以正解是：**关掉本机生成、把常用汉字也造成 PBF**，让整段文字只有一个字形来源。
    ///
    /// 给了白名单就只造名单里的汉字（`0x3400~0x9FFF` 之外的非汉字照常全造：ASCII / 标点 / 全角）。
    /// 名单外的生僻字将**没有字形、不显示** —— 这是"只覆盖常用字"的代价，由宿主决定名单范围。
    /// </param>
    public static string Run(string fontFamily, string stackName, string outDir, int[] rangeStarts, HashSet<int> cjkWhitelist = null)
    {
        Directory.CreateDirectory(outDir);
        var sb = new StringBuilder();
        using (var probe = new Bitmap(1, 1))
        using (var pg = Graphics.FromImage(probe))
        using (var fam = new FontFamily(fontFamily))
        using (var font = new Font(fam, EM, FontStyle.Regular, GraphicsUnit.Pixel))
        {
            float emHeight = fam.GetEmHeight(FontStyle.Regular);
            float ascent = fam.GetCellAscent(FontStyle.Regular) / emHeight * EM;

            foreach (int start in rangeStarts)
            {
                var glyphMsgs = new List<byte[]>();
                for (int cp = start; cp < start + 256; cp++)
                {
                    // 汉字按白名单过滤；非汉字（键盘字符/标点/全角）照常全造
                    if (cjkWhitelist != null && cp >= 0x3400 && cp <= 0x9FFF && !cjkWhitelist.Contains(cp)) continue;
                    var g = BuildGlyph(font, fam, ascent, cp, pg);
                    if (g != null) glyphMsgs.Add(g);
                }
                if (glyphMsgs.Count == 0) continue;
                var file = EncodeFile(stackName, start, glyphMsgs);
                var name = start + "-" + (start + 255) + ".pbf";
                File.WriteAllBytes(Path.Combine(outDir, name), file);
                sb.AppendLine("  " + name + "  " + glyphMsgs.Count + " 个字形  " + (file.Length / 1024) + " KB");
            }
        }
        return sb.ToString();
    }

    // ---------------------------------------------------------------- 单个字形 → Glyph 消息
    static byte[] BuildGlyph(Font font, FontFamily fam, float ascent, int cp, Graphics measure)
    {
        string s;
        try { s = char.ConvertFromUtf32(cp); } catch { return null; }

        // ⚠️ **空白字符（U+0020 等）必须也有字形**，哪怕它一点墨迹都没有。
        //    第一版用"墨迹包围盒非空"当"字体里有这个字形"的判据，空格因此被整条滤掉；
        //    结果是 MapLibre 在缺字形处**断行**：线上实测「光电 opt-005」被拆成两行
        //    （「光电」一行、`opt-005` 一行，而且怎么调 `text-max-width` 都没用）。
        bool blank = char.IsWhiteSpace(s, 0);
        if (!blank && !IsRenderable(fam, cp)) return null;

        RectangleF b = RectangleF.Empty;
        using (var path = new GraphicsPath())
        {
            try
            {
                path.AddString(s, fam, (int)font.Style, EM, new PointF(0, 0), StringFormat.GenericTypographic);
            }
            catch { return null; }
            if (path.PointCount > 0) b = path.GetBounds();
            else if (!blank) return null;
        }
        int tightW = (int)Math.Ceiling(b.Right) - (int)Math.Floor(b.Left);
        int tightH = (int)Math.Ceiling(b.Bottom) - (int)Math.Floor(b.Top);
        if (blank) { tightW = 0; tightH = 0; }     // 零尺寸位图（只剩 6×6 的边框，值全 0 = 全透明）
        if (tightW < 0 || tightH < 0 || tightW > 200 || tightH > 200) return null;
        if (!blank && (tightW == 0 || tightH == 0)) return null;

        int w = tightW + BORDER * 2;
        int h = tightH + BORDER * 2;
        int left = (int)Math.Floor(b.Left) - BORDER;                 // 相对笔起点的左偏移
        int top = (int)Math.Round(ascent - b.Top) + BORDER;          // 基线上方为正
        if (blank) { left = 0; top = 0; }                            // 空白字形不参与定位

        // 1) 栅格化：把字形按 (dx,dy) 平移到 padded 位图里
        var mask = new bool[w * h];
        using (var bmp = new Bitmap(w, h))
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Black);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float dx = -(float)Math.Floor(b.Left) + BORDER;
            float dy = -(float)Math.Floor(b.Top) + BORDER;
            using (var path = new GraphicsPath())
            {
                path.AddString(s, fam, (int)font.Style, EM, new PointF(dx, dy), StringFormat.GenericTypographic);
                using (var br = new SolidBrush(Color.White)) g.FillPath(br, path);
            }
            // 锁定位图读取
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.ReadOnly,
                                    System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            try
            {
                var buf = new byte[Math.Abs(data.Stride) * h];
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, buf.Length);
                for (int y = 0; y < h; y++)
                    for (int x = 0; x < w; x++)
                    {
                        // ⚠️ 读**亮度**（BGRA 里的 R），不是 Alpha！
                        //    GDI+ 的 32bppArgb 位图上，`Graphics` 画出来的抗锯齿体现在 RGB 上，
                        //    **A 通道恒为 255**。第一版读的是 A → 整格都判成"字形内部"，
                        //    于是所有拉丁字母/数字在图上渲染成一个个白色实心方块（2026-09-18 实测踩到）。
                        byte lum = buf[y * Math.Abs(data.Stride) + x * 4 + 2];
                        mask[y * w + x] = lum > 127;
                    }
            }
            finally { bmp.UnlockBits(data); }
        }

        // 2) SDF
        //    注：曾经在这里做过 `Dilate(mask, 1)` 的整体描粗 —— 1px 膨胀等于笔画 +2px，
        //    需求方反馈"太粗，粘在一起"（汉字笔画密，加粗后相邻笔画会糊成一坨）。
        //    现在改用**边缘值**做更细的加粗（见 EDGE），一个数就能调，且不粘连。
        var sdf = Sdf(mask, w, h);

        // 3) advance（笔进位）：用**排版模式**量，量不出来就退回字宽
        //    （`MeasureString` 的简版在这个 1×1 的 Graphics 上对单字符会给出 0，
        //      第一版就是这么写出 advance=0 的字形的）
        float adv;
        try
        {
            int fitted, lines;
            adv = measure.MeasureString(s, font, new SizeF(1000f, 1000f),
                                        StringFormat.GenericTypographic, out fitted, out lines).Width;
        }
        catch { adv = 0f; }
        if (float.IsNaN(adv) || adv <= 0f) adv = blank ? EM / 4f : tightW;   // 空白字形的兜底宽度

        // 4) 编码 Glyph
        var body = new MemoryStream();
        WriteVarintField(body, 1, (ulong)cp);
        WriteBytesField(body, 2, sdf);
        WriteVarintField(body, 3, (ulong)tightW);
        WriteVarintField(body, 4, (ulong)tightH);
        WriteSVarintField(body, 5, left);
        WriteSVarintField(body, 6, top);
        WriteVarintField(body, 7, (ulong)Math.Max(0, (int)Math.Round(adv)));
        return body.ToArray();
    }

    /// <summary>字体里到底有没有这个字形（没有就让 MapLibre 去问别的 fontstack）</summary>
    static bool IsRenderable(FontFamily fam, int cp)
    {
        // GDI+ 没有直接接口；用 AddString 的点数判断：不支持时 GDI+ 会回退成方框或空
        try
        {
            using (var p = new GraphicsPath())
            {
                p.AddString(char.ConvertFromUtf32(cp), fam, 0, EM, new PointF(0, 0), StringFormat.GenericTypographic);
                var b = p.GetBounds();
                return p.PointCount > 0 && b.Width > 0 && b.Height > 0;
            }
        }
        catch { return false; }
    }

    // ---------------------------------------------------------------- 描粗
    /// <summary>
    /// 把字形**描粗** n 像素（3×3 膨胀 n 次）。
    ///
    /// 为什么要描粗：需求方一直反馈"字糊"。查下来不是分辨率问题 —— MapLibre 的 SDF 文字**没有
    /// 字形微调（hinting）**，24px 汉字的笔画只有 2~3px，按几何画出来在影像背景上就是"细而发虚"。
    /// 地图标签的常规做法是**把字加粗**（相当于 Medium/Bold 字重）：笔画变实，配合黑色描边就利落。
    ///
    /// 试过"把字形按 48px em 生成"（更好的采样密度）——**格式上不通**：PBF 的 `width/height`
    /// 既是位图像素尺寸、又是渲染四边形的尺寸（按 `fontSize/24` 缩放），位图放大而度量减半会让
    /// 图集切片与数据长度对不上。所以走描粗这条能落地的路。
    /// </summary>
    static bool[] Dilate(bool[] mask, int w, int h, int n)
    {
        var cur = mask;
        for (int k = 0; k < n; k++)
        {
            var next = new bool[w * h];
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    bool on = false;
                    for (int dy = -1; dy <= 1 && !on; dy++)
                    {
                        for (int dx = -1; dx <= 1 && !on; dx++)
                        {
                            int nx = x + dx, ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                            if (cur[ny * w + nx]) on = true;
                        }
                    }
                    next[y * w + x] = on;
                        }
            }
            cur = next;
        }
        return cur;
    }

    /// <summary>
    /// SDF 编码 —— **必须与 MapLibre 的 SDF 着色器对齐**，否则笔画会胖一圈、边缘发糊。
    ///
    /// 依据（在 maplibre-gl 4.7.1 的 `symbolSDF` 着色器里核过）：
    ///   `#define SDF_PX 8.0` + `alpha = smoothstep(0.5 - u_sdfgamma/floorwidth,
    ///                                          0.5 + u_sdfgamma/floorwidth, sdfdist)`
    ///   本工程实测：**边缘值取 0.75**（不是文档写的 0.5）时"填充那一遍"才画得出来 ——
    ///   0.5 时只画出描边那一遍（观感是"黑字"），0.65 时字形被向内削瘦成"骨架"。
    /// </summary>
    static byte[] Sdf(bool[] mask, int w, int h)
    {
        var din = new float[w * h];   // 到"最近背景像素"的距离
        var dout = new float[w * h];  // 到"最近前景像素"的距离
        const float INF = 1e9f;
        for (int i = 0; i < w * h; i++) { din[i] = mask[i] ? INF : 0f; dout[i] = mask[i] ? 0f : INF; }
        Edt2D(din, w, h);
        Edt2D(dout, w, h);

        var outp = new byte[w * h];
        for (int i = 0; i < w * h; i++)
        {
            // 有符号距离：内部为负、外部为正；`EDGE` 是"字形几何边缘"落在 SDF 上的值。
            //
            // ⚠️ 这一行试了四轮（每轮都重生成 84 段字形 + 实拍），最终值是 EDGE=0.75 / RADIUS=8：
            //   · 0.75（本值）：填充与描边两遍都正常，字形实心、粗细正确 ✓
            //   · 0.50：**填充那一遍不画** → 只看到描边（黑字）；描边归零则整层字消失
            //   · 0.65：字形被向内削掉约 1.2px → 汉字只剩"细线骨架"（看着就是"糊/断"）
            //   结论：本工程 MapLibre 的 SDF 着色器阈值在 0.75 附近，不是文档写的 0.5。
            float d = mask[i] ? -din[i] : dout[i];
            float v = 255f * (EDGE - d / RADIUS);
            if (float.IsNaN(v) || float.IsInfinity(v) || v < 0f) v = 0f; else if (v > 255f) v = 255f;
            outp[i] = (byte)Math.Round(v);
        }
        return outp;
    }

    /// <summary>2D 欧氏距离变换（Felzenszwalb & Huttenlocher，线性时间）</summary>
    static void Edt2D(float[] f, int w, int h)
    {
        int n = Math.Max(w, h);
        var tmp = new float[n];
        var v = new int[n + 1];      // 抛物线位置（Edt1D 里会写 v[k+1] 之外还要 z[k+1]）
        var z = new float[n + 2];    // 抛物线边界：**必须 n+1 起步**，否则越界
        var d = new float[n];
        for (int x = 0; x < w; x++)
        {
            for (int y = 0; y < h; y++) tmp[y] = f[y * w + x];
            Edt1D(tmp, h, d, v, z);
            for (int y = 0; y < h; y++) f[y * w + x] = d[y];
        }
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++) tmp[x] = f[y * w + x];
            Edt1D(tmp, w, d, v, z);
            for (int x = 0; x < w; x++) f[y * w + x] = d[x];
        }
    }

    static void Edt1D(float[] f, int n, float[] d, int[] v, float[] z)
    {
        int k = 0;
        v[0] = 0;
        z[0] = -1e20f; z[1] = 1e20f;
        for (int q = 1; q < n; q++)
        {
            float s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2f * q - 2f * v[k]);
            while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2f * q - 2f * v[k]); }
            k++; v[k] = q; z[k] = s; z[k + 1] = 1e20f;
        }
        k = 0;
        for (int q = 0; q < n; q++)
        {
            while (z[k + 1] < q) k++;
            float dq = q - v[k];
            d[q] = dq * dq + f[v[k]];
        }
    }

    // ---------------------------------------------------------------- 文件级编码
    static byte[] EncodeFile(string stackName, int rangeStart, List<byte[]> glyphs)
    {
        var fsBody = new MemoryStream();
        WriteStringField(fsBody, 1, stackName);
        WriteStringField(fsBody, 2, rangeStart + "-" + (rangeStart + 255));
        foreach (var g in glyphs) WriteBytesField(fsBody, 3, g);

        var top = new MemoryStream();
        WriteBytesField(top, 1, fsBody.ToArray());
        return top.ToArray();
    }

    // ---------------------------------------------------------------- protobuf 小工具
    static void Varint(Stream s, ulong v)
    {
        while (v >= 0x80) { s.WriteByte((byte)((v & 0x7F) | 0x80)); v >>= 7; }
        s.WriteByte((byte)v);
    }
    static void Tag(Stream s, int field, int wire) { Varint(s, (ulong)((field << 3) | wire)); }
    static void WriteVarintField(Stream s, int f, ulong v) { Tag(s, f, 0); Varint(s, v); }
    static void WriteSVarintField(Stream s, int f, int v)
    {
        Tag(s, f, 0);
        ulong zz = (ulong)((v << 1) ^ (v >> 31));   // zigzag
        Varint(s, zz);
    }
    static void WriteBytesField(Stream s, int f, byte[] b) { Tag(s, f, 2); Varint(s, (ulong)b.Length); s.Write(b, 0, b.Length); }
    static void WriteStringField(Stream s, int f, string t) { WriteBytesField(s, f, Encoding.UTF8.GetBytes(t)); }
}
