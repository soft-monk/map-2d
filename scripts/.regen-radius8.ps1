# map-2d · scripts/.regen-radius8.ps1
#
# **重新生成字形 PBF（RADIUS 2 → 8）** —— 2026-09-21 需求："当前绘制的标签太难看了，字体糊，对比度低"。
#
# 与 `.regen-common.ps1` 的关系：白名单与分段算法**逐字照抄**它（那是当前出货字形的来源，
# 已用逐文件 SHA256 比对证明：`.glyphs-common` 与 `apps/web/public/fonts/MapApp` 完全相同）。
# 本脚本只做三件不同的事：
#   ① 字体仍是 **Noto Sans SC**（度量与本机 `NotoSansSC-VF.ttf` 同源，决定字框宽度，绝不能换）；
#   ② 生成器里 `RADIUS` 已由 2 改为 8、`EDGE` 由 0.95 改为 0.80（加粗量不变，只把过渡带拉宽 4 倍）；
#   ③ 先落到**临时目录**，比对通过才替换出货目录 —— 避免半成品覆盖线上字形。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\.regen-radius8.ps1
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -Path "D:\dsh_workpath\webMap\map-2d\scripts\gen-glyphs.cs" -ReferencedAssemblies System.Drawing

# ---- 1) 常用字名单：GB2312 一级汉字（0xB0A1~0xD7F9）+ 应用源码里实际用到的汉字 ----
$cjk = New-Object 'System.Collections.Generic.HashSet[int]'
$enc = [System.Text.Encoding]::GetEncoding(936)
for ($b1 = 0xB0; $b1 -le 0xD7; $b1++) {
    for ($b2 = 0xA1; $b2 -le 0xFE; $b2++) {
        $s = $enc.GetString([byte[]]@($b1, $b2))
        if ($s.Length -eq 1) { $cp = [int][char]$s[0]; if ($cp -ge 0x4E00 -and $cp -le 0x9FFF) { [void]$cjk.Add($cp) } }
    }
}
Write-Host "GB2312 一级汉字 = $($cjk.Count) 个"

$before = $cjk.Count
$files = Get-ChildItem -Recurse -Path "D:\dsh_workpath\webMap\mission-app\apps\web\src" -Include *.ts,*.tsx,*.json -File
foreach ($f in $files) {
    $t = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)
    foreach ($ch in $t.ToCharArray()) {
        $cp = [int]$ch
        if ($cp -ge 0x3400 -and $cp -le 0x9FFF) { [void]$cjk.Add($cp) }
    }
}
Write-Host "加上应用源码用字后 = $($cjk.Count) 个（新增 $($cjk.Count - $before)）"

# ---- 2) 需要哪些 256 段 ----
$starts = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($cp in $cjk) { [void]$starts.Add([int]([math]::Floor($cp / 256) * 256)) }
foreach ($s in @(0, 8192, 12288, 65280)) { [void]$starts.Add($s) }
$startArr = @($starts | Sort-Object)
Write-Host "共 $($startArr.Count) 段（起 $($startArr[0]) 止 $($startArr[-1])）"

# ---- 3) 生成到临时目录 ----
$out = "D:\dsh_workpath\webMap\map-2d\scripts\.glyphs-radius8"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
$log = [GlyphGen]::Run('Noto Sans SC', 'MapApp', $out, [int[]]$startArr, $cjk)
$total = (Get-ChildItem $out | Measure-Object -Property Length -Sum).Sum
Write-Host "生成完成：$((Get-ChildItem $out).Count) 个文件，合计 $([math]::Round($total/1MB, 2)) MB"

# ---- 4) 与出货目录比对：**分段集合必须一致**（度量一致性由"同字体 + 同白名单"保证）----
$shipped = "D:\dsh_workpath\webMap\mission-app\apps\web\public\fonts\MapApp"
$na = @(Get-ChildItem $out -File | Sort-Object Name | ForEach-Object { $_.Name })
$nb = @(Get-ChildItem $shipped -File | Sort-Object Name | ForEach-Object { $_.Name })
$diff = @(Compare-Object $na $nb)
Write-Host "分段集合与出货版一致？ $($diff.Count -eq 0)（差异 $($diff.Count) 项）"
if ($diff.Count -ne 0) { throw "分段集合不一致，不替换（先查白名单/分段算法）" }

# ---- 5) 替换出货目录 ----
Copy-Item (Join-Path $out '*') $shipped -Force
Write-Host "已替换：$shipped"
Get-ChildItem $shipped -File | Sort-Object LastWriteTime | Select-Object -First 1 Name, LastWriteTime | Format-Table -AutoSize | Out-String
Write-Host "下一步：重建前端（apps/web 的 vite build），然后刷新页面看观感"
