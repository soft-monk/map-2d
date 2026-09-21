// mission-app · map-2d · scripts/gen-glyphs.cs
//
// **离线字形生成器**：把本机字体栅格化成 MapLibre 的 glyph PBF（SDF）。
//
// ⚠️ 本文件有一段**关于"标签还不够清楚"的现状与候选改法**（2026-09-21 结论，需求方决定"本轮放弃、
//    后续再改"）。**要动字号 / 字形 / 清晰度之前，先读文件尾部的「附着：标签清晰度现状与候选改法」**——
//    那里记着根因、四条候选路线的代价、以及哪些数据还没实测，省得重新排查一遍。
//
// 为什么只需要生成"非表意字符"这几段：
//   MapLibre 的 `GlyphManager._doesCharSupportLocalGlyph` 是这么判的（见 maplibre-gl 源码）：
//       return !!this.localIdeographFontFamily &&
//         /\p{Ideo}|\p{sc=Hang}|\p{sc=Hira}|\p{sc=Kana}/u.test(String.fromCodePoint(id));
//   也就是说**当 `localIdeographFontFamily` 非空时**，汉字/假名/韩文会走 `TinySDF` 在浏览器里
//   用本机字体实时生成、压根不请求 PBF。
//
//   ★ 但本工程的现状是 **`MAP_OPTIONS.localIdeographFontFamily = ''`（关闭本机生成）**，
//     所以**汉字也必须由本文件生成 PBF** —— 否则那些字没有字形、直接不显示。
//     实际生成范围见 `scripts/.regen-radius8.ps1`（当前出货版本）：
//       GB2312 一级汉字 3755 个 + 应用源码里出现的字 = 3758 个，铺开 **84 段**，合计 **约 3.6 MB**。
//     （早先"只造非表意字符、不到 1000 码位"的那版说明已经过期，这里按现状更正。）
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
//   · SDF 的编码口径以本文件下方的 `EDGE` / `RADIUS` 两个常量为准（那两个数每次调整都写了理由）。
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
    // SDF 半径：**8**（2026-09-21 由 2 改回 8）。
    //
    // 它决定**梯度有多陡**，也就是抗锯齿过渡带有多宽：MapLibre 的 SDF 着色器直接拿这个梯度
    // （`SDF_PX = 8`）做 `smoothstep`，所以半径越小 → 过渡带越窄 → 边缘越"硬"（发毛、发虚）。
    //   历史：上一轮为了让 24px 汉字"看着锐"把半径收到 2 —— 那是把边缘做硬，不是做清；
    //   实测观感仍是"细而发虚"（需求方 2026-09-21 反馈"字体糊、对比度低"）。
    //   现在改回 8（与 MapLibre 官方 TinySDF 口径一致）：过渡带宽 4 倍，边缘是**平滑**而不是硬切。
    //
    // ⚠️ 半径变了，**加粗量必须重新算**（见下面的 EDGE）：加粗量 = (EDGE − 阈值) × RADIUS，
    //   想把"笔画 +0.8px"这条观感保持住，EDGE 就要跟着半径一起改。
    const int RADIUS = 8;
    // **边缘值 0.8** —— 这一个数同时管两件事，是本生成器最重要的旋钮：
    //   · 字形胖瘦：着色器实际阈值实测在 0.75 附近（= 字形几何边缘）。
    //     给 0.75 → 笔画就是原始粗细（需求方反馈"糊/细"）；
    //     RADIUS=2 时给 0.95 → 轮廓外移 (0.95−0.75)×2 = 0.4px/边 ≈ **笔画 +0.8px**（"半粗"，不粘连）；
    //     RADIUS=8 时同一个加粗量要 0.75 + 0.4/8 = **0.80**（就是本值）—— 加粗量与旧版一致，只是边缘更平滑；
    //     给 0.65 → 反向内缩，字形被削成"骨架"。
    //   · 填充能不能画出来：值太低（如 0.5）时笔画内部的 SDF 值过不了阈值，
    //     **填充那一遍整遍不画**，只剩描边（观感是"黑字"）。
    const float EDGE = 0.8f;

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
            // ⚠️ 这一行试了四轮（每轮都重生成 84 段字形 + 实拍），当时的结论是 EDGE=0.75 / RADIUS=8；
            //   2026-09-21 又改回 RADIUS=8 并相应把 EDGE 收到 0.80（加粗量与 RADIUS=2/EDGE=0.95 那版一致，
            //   见文件头那两个常量的注释）。历史结论仍然有效，作为**阈值锚点**记在这里：
            //   · 0.75：字形几何边缘（阈值锚点；等于"不加粗"）
            //   · 0.50：**填充那一遍不画** → 只看到描边（黑字）；描边归零则整层字消失
            //   · 0.65：字形被向内削掉约 1.2px（RADIUS=8 时）→ 汉字只剩"细线骨架"
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

// ============================================================================
// 附着：标签清晰度现状与候选改法（2026-09-21）
// ============================================================================
//
// 状态：**需求方决定"本轮放弃、后续再改"** —— 也就是说：下面这些**都还没做**。
// 触发这句话的原话是："当前绘制的标签太难看了，字体糊，对比度低"。
//
// ── 已经做掉的两档（作为后续改动的**基线**，别推翻重来）─────────────────────────
//   A（渲染参数，落在 `src/render/LayerManager.ts` + `src/primitives/text-layer.ts`）：
//       `text-halo-width` 0 → 1.0（细黑描边）、底块不透明度 0.68 → 0.85、框边线 .40 → .55。
//       ⇒ "对比度低"这条基本解决；**字发虚**没解决。
//   B（字形参数，就是本文件）：`RADIUS` 2 → 8、`EDGE` 0.95 → 0.80（加粗量不变，只把 SDF
//       过渡带拉宽 4 倍）。抽样验证：字形 SDF 直方图由 3 档变 6 档（边缘过渡更连续）。
//       ⇒ 边缘"不那么硬切了"，但**观感仍然糊**（需求方看过新字形的实拍后如此反馈）。
//
// ── 根因（四条，按影响排序；这是重新排查时要先认下的结论）───────────────────────
//   1（主因）**笔画太细、扛不住 SDF 的抗锯齿**：`EM = 24`（见上方常量），24px 的**常规字重**汉字
//     横画只有 2~3px，而 SDF 的抗锯齿过渡带本身就横跨约 ±2px ⇒ 笔画一半被"边缘过渡"吃掉，
//     中心到不了纯白 ⇒ 看着既灰又糊。**光调 `RADIUS`/`EDGE` 改不动这一条**（它们只调边缘与胖瘦）。
//   2 **贴图被放大采样**：字形在 PBF 里按 EM=24 存成贴图，屏幕上的 `text-size: 24` 在
//     高分屏 / 浏览器缩放（非 100%）下要画成 24×dpr 个物理像素 ⇒ 贴图被双线性放大，再糊一层。
//   3 **亚像素落位**：标签锚点是经纬度投影后的浮点坐标，文字常落在半像素位置，采样又糊一点。
//   4 **底块已经够实**（A 之后）：剩下的"糊"不是对比度问题，别再往对比度上使劲。
//
// ── 候选改法（按性价比排序；每条都写了代价，改之前先读代价）──────────────────────
//   ①【推荐·治本·不换字体】`EM` 24 → 48，`RADIUS` 8 → 16，并把 `EDGE` 调成"笔画约 +1.2px"。
//      收益：字形贴图密度翻倍（高分屏不再放大）+ 笔画相对过渡带更宽 —— 两个字面收益叠加。
//      代价：字形总量约 3.6MB → 7MB（本机 localhost 可忽略）；要重生成 84 段 + 重建前端。
//      ⚠️ 本文件上方旧注释里写过"48px 试过、格式上不通" —— 那是因为当时**没同时调**
//         `EM`/`RADIUS`/`BORDER` 与 `width/height`、bitmap 边距（`(width+6)*(height+6)`）的换算。
//         **必须四个一起改**，并重新核对 `advance`（它与 `text-layer.ts` 量字宽同源）。
//   ②【换字体·收益大】改用更粗的字体生成：现状是 `Noto Sans SC` **可变字体**
//      （`C:\Windows\Fonts\NotoSansSC-VF.ttf`），而 `System.Drawing`(GDI+) **不支持可变字重**，
//      只会取**默认 Regular** ⇒ 天生偏细。本机可用的更粗选择：`msyhbd.ttc`（微软雅黑粗体）、
//      `simhei.ttf`（黑体）、`Dengb.ttf`（等线粗体）。
//      代价：**字体度量会变** ⇒ 底块（模块按字形量宽高，见 `src/primitives/text-layer.ts`）要重对，
//      中英混排间距也会变。换字体后要连带复看标签与底块是否仍然对齐。
//   ③【最锐·改渲染路线】开 `MAP_OPTIONS.localIdeographFontFamily`（`src/core/options.ts`，现为空），
//      汉字改由**浏览器用系统字体在显示尺寸上直接栅格化**：没有贴图放大、没有 SDF 柔和。
//      代价：① 字形来源变两套（拉丁 PBF / 汉字本机）—— 工程里记着当年"混排被拆成两块"的坑
//      （同文件 `options.ts` 的注释有完整记录），必须逐条复验；② 导出整图时画布里没有汉字
//      （已查：宿主当前**没有任何地方**调用 `exportImage`/`downloadImage`，所以这条代价对
//      当前应用**不成立**；将来若要用导出能力，必须先解决）。
//   ④【最省事】主标签 `text-size` 24 → 28~30（`src/render/LayerManager.ts` 的 `textLayer()`）：
//      字号越大，笔画相对过渡带越宽 ⇒ 立刻更清楚。
//      代价：标签更大、遮地图更多；且**只对那一条图层生效**（无人机 11.5px 等其它文字图层仍是软的，
//      要统一就得一起调）。
//
// ── 还没实测的东西（下次动手前先补，别凭感觉调）──────────────────────────────
//   · 没做**对照实验**：同一段文字分别用「现 24px 字形 / EM 48 字形 / 本机字体」渲染成图对比。
//     这是把①③里"到底够不够"一次说清的最短路径（可在无头浏览器里截图做）。
//   · 需求方给过的截图是 **158×42 的缩略图**，缩放本身会再糊一层 —— 判断严重程度需要**原尺寸**截图。
//   · `text-size: 24` 的注释里写着"24px 是 1:1、最清晰的一档"，那条结论**建立在 EM=24 的前提上**；
//     若采纳①把 EM 改成 48，这句话就过期了，要一并更正（`LayerManager.ts` 的 `textLayer()`）。
//
// ── 相关落点（改的时候一并看）────────────────────────────────────────────────
//   · 字形生成（本文件）：`EM` / `RADIUS` / `EDGE` / `BORDER` / `BuildGlyph` / `Sdf`
//   · 重生成脚本：`scripts/.regen-common.ps1`（字体 = Noto Sans SC，当前出货版本的来源）、
//     `scripts/.regen-radius8.ps1`（RADIUS=8 那版；含"先落临时目录、比对分段一致才替换"的保护）
//   · 渲染侧：`src/render/LayerManager.ts`（`textLayer()` / `textBoxLayers()`）、
//     `src/primitives/text-layer.ts`（逐要素属性：底块 opacity 在这里也要同步改）
//   · 需求侧记录：`mission-app/docs/参考/需求确认单.md` 的变更记录（"标签太难看了"那条）
//   · 字形由宿主**从磁盘实时读**（`/fonts/MapApp/*.pbf`），所以换字形**不需要重启宿主**，
//     重建前端 + 硬刷新页面即可；但**浏览器可能缓存字形**（304），必要时强刷或清缓存。
