# map-2d · 离线 sprite 生成器（2026-09-18）
#
# 为什么需要 sprite：MapLibre 的 `symbol` 图层只有"文字描边"（`text-halo`），**没有文字底色块**。
# 要给文本框画真正的底色 + 边框，标准做法是：
#   · 造一张**小图**放进 `sprite`（MapLibre 的图片图集：一张 PNG + 一个 JSON）
#   · 图层上写 `icon-image` + `icon-text-fit: 'both'` + `icon-text-fit-padding`
#     → 渲染器把这张小图**拉伸到和文字一样大**垫在文字下面，就是"文本框"
#   · JSON 里给每张图标 `content`（左/上/右/下 四边不拉伸的区域）→ **圆角与边框不会被拉变形**
#     （`content` 就是 9 宫格那条"中间可拉伸"的界定，MapLibre 的 `icon-text-fit` 认这个字段）
#
# 产物（1x + @2x 两套，浏览器按 devicePixelRatio 自己挑）：
#   <outDir>/mapapp.png / mapapp.json / mapapp@2x.png / mapapp@2x.json
# 摆到宿主能静态托管的位置（本应用是 `apps/web/public/sprites/`，与字形同一套静态路由）。
#
# ⚠️ 本文件必须存成 **UTF-8 with BOM**：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解，
#    中文注释会变乱码并可能吃掉后面几行代码（这次就踩到了 —— `$H` / `$contentBox` 两行被吞）。
#
# 用法：powershell -ExecutionPolicy Bypass -File gen-sprite.ps1 -OutDir <目录>
param(
  [Parameter(Mandatory = $true)][string]$OutDir
)
Add-Type -AssemblyName System.Drawing

# 三种文本框样式各一张（与 `TEXT_STYLES` 及原 HTML 浮层的取值对齐）
$boxes = @(
  @{ name = 'textbox-tag';     fill = [System.Drawing.Color]::FromArgb(209, 10, 29, 51); border = [System.Drawing.Color]::FromArgb(115, 95, 176, 255); radius = 3 },
  @{ name = 'textbox-card';    fill = [System.Drawing.Color]::FromArgb(235,  6, 26, 47); border = [System.Drawing.Color]::FromArgb(140, 95, 176, 255); radius = 3 },
  @{ name = 'textbox-callout'; fill = [System.Drawing.Color]::FromArgb(230,  6, 26, 47); border = [System.Drawing.Color]::FromArgb(115, 95, 176, 255); radius = 3 }
)

$BOX_W = 32      # 每张图的宽（1x）
$BOX_H = 16      # 每张图的高（1x）
# 四边"不拉伸"的宽度（圆角 + 边框余量），中间那一段会被拉长。
$inset = @{ left = 4; top = 4; right = 4; bottom = 4 }
#
# ⚠️⚠️ JSON 里的 `content` 是**内容矩形 [x1, y1, x2, y2]**（不是"内缩量"！），这是本次最大的坑：
#      MapLibre 的九宫格（`symbol_quads` 的 sh()）把 content 当**坐标**用 ——
#      `ah(stretchX, 0, content[0])` 就是"左边固定那一段"。
#      第一版按"内缩 [4,4,4,4]"写，等于给了一个**零面积矩形** →
#      中间可拉伸段退化为 0、九宫格画不出来 → **底块整块消失**；
#      而且图层上怎么调 `icon-text-fit-padding` 都毫无反应（因为根本不是 padding 的问题）。
#      正确写法：content = [左内缩, 上内缩, 宽 − 右内缩, 高 − 下内缩]。
#      （另外 `icon-text-fit-padding` 要 ≥ 内缩，否则目标框比固定边还小，中间段同样为负。）

function New-RoundedPath([int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Sprite([int]$scale, [string]$pngPath, [string]$jsonPath) {
  $imgW = $BOX_W * $scale
  $imgH = $BOX_H * $scale
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList @(($imgW * $boxes.Count), $imgH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # content = 内容**矩形**（左上角 + 右下角），不是内缩量 —— 见文件头的说明
  $contentRect = @(
    [int]($inset.left * $scale), [int]($inset.top * $scale),
    [int](($BOX_W - $inset.right) * $scale), [int](($BOX_H - $inset.bottom) * $scale)
  )
  $entries = [ordered]@{}
  $x = 0
  foreach ($b in $boxes) {
    # 三张图横向排开：**绘制时也要平移到 $x**（只写进 JSON 是不够的 —— 第一版漏了这步，
    # 三张图全叠在原点，sprite 里看起来只有一张）
    $g.TranslateTransform([float]$x, 0)
    $path = New-RoundedPath $imgW $imgH ([int]($b.radius * $scale))
    $brush = New-Object System.Drawing.SolidBrush $b.fill
    $pen = New-Object System.Drawing.Pen $b.border, ([float](1.0 * $scale))
    $g.FillPath($brush, $path)
    $g.DrawPath($pen, $path)
    $g.ResetTransform()
    $brush.Dispose(); $pen.Dispose(); $path.Dispose()

    $entries[$b.name] = [ordered]@{
      x          = $x
      y          = 0
      width      = $imgW
      height     = $imgH
      pixelRatio = $scale
      content    = $contentRect
    }
    $x += $imgW
  }
  $g.Dispose()
  $bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host ("  {0}  {1}x{2}  {3} 张图" -f (Split-Path $pngPath -Leaf), $bmp.Width, $imgH, $boxes.Count)
  $bmp.Dispose()
  ($entries | ConvertTo-Json -Depth 5) | Set-Content -Path $jsonPath -Encoding UTF8
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
New-Sprite 1 (Join-Path $OutDir 'mapapp.png')    (Join-Path $OutDir 'mapapp.json')
New-Sprite 2 (Join-Path $OutDir 'mapapp@2x.png') (Join-Path $OutDir 'mapapp@2x.json')
Write-Host "sprite 已生成到 $OutDir"
