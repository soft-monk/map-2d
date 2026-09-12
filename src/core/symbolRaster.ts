// 国军标符号的像素栅格化（替换原来的"SVG → canvas 解码"方案）
//
// 为什么不用 SVG：把 SVG data URL 画进 canvas 需要**异步解码**，
// 而 MapLibre 的 addImage 需要同步拿到像素——同步 drawImage 的结果是一张空图
// （实测注册后的图片非空像素为 0，符号层 queryRenderedFeatures 命中 0）。
// 这里改成自己按 32×32 画：同步、无依赖、可精确控制线宽与填充。
import type { SymbolAffiliation } from './symbols'

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 简易画布：RGBA 缓冲 + 基础图元（描点/线段/圆/多边形填充） */
class Raster {
  readonly size: number
  readonly buf: Uint8ClampedArray

  constructor(size = 32) {
    this.size = size
    this.buf = new Uint8ClampedArray(size * size * 4)
  }

  private px(x: number, y: number, c: RGB, a = 255) {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.size || yi >= this.size) return
    const i = (yi * this.size + xi) * 4
    const alpha = a / 255
    // 直接覆盖（符号是纯色线稿，不需要混色）
    this.buf[i] = c[0]
    this.buf[i + 1] = c[1]
    this.buf[i + 2] = c[2]
    this.buf[i + 3] = Math.max(this.buf[i + 3], Math.round(255 * alpha))
  }

  /** 画一条线（Bresenham） */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, w = 1) {
    let x = Math.round(x0)
    let y = Math.round(y0)
    const xe = Math.round(x1)
    const ye = Math.round(y1)
    const dx = Math.abs(xe - x)
    const dy = Math.abs(ye - y)
    const sx = x < xe ? 1 : -1
    const sy = y < ye ? 1 : -1
    let err = dx - dy
    for (;;) {
      this.disk(x, y, w / 2, c)
      if (x === xe && y === ye) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x += sx }
      if (e2 < dx) { err += dx; y += sy }
    }
  }

  /** 实心圆点（半径 <=0 时画 1px） */
  disk(cx: number, cy: number, r: number, c: RGB) {
    if (r <= 0.5) { this.px(cx, cy, c); return }
    const rr = r * r
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= rr) this.px(x, y, c)
      }
    }
  }

  /** 圆环 */
  circle(cx: number, cy: number, r: number, c: RGB, w = 1.4) {
    const steps = 96
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      this.disk(cx + Math.cos(a) * r, cy + Math.sin(a) * r, w / 2, c)
    }
  }

  /** 椭圆环 */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, w = 1.4) {
    const steps = 96
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      this.disk(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, w / 2, c)
    }
  }

  /** 多边形描边 */
  poly(points: [number, number][], c: RGB, w = 1.6, close = true) {
    for (let i = 0; i < points.length - 1; i++) {
      this.line(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], c, w)
    }
    if (close && points.length > 2) {
      const a = points[points.length - 1]
      const b = points[0]
      this.line(a[0], a[1], b[0], b[1], c, w)
    }
  }

  /** 矩形描边 */
  rect(x: number, y: number, w: number, h: number, c: RGB, lw = 1.6, radius = 0) {
    if (radius <= 0) {
      this.poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c, lw)
      return
    }
    const r = radius
    this.line(x + r, y, x + w - r, y, c, lw)
    this.line(x + w, y + r, x + w, y + h - r, c, lw)
    this.line(x + w - r, y + h, x + r, y + h, c, lw)
    this.line(x, y + h - r, x, y + r, c, lw)
    // 四角圆弧
    const corners: [number, number, number][] = [[x + r, y + r, Math.PI], [x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2]]
    for (const [cx, cy, a0] of corners) {
      for (let i = 0; i <= 16; i++) {
        const a = a0 + (i / 16) * (Math.PI / 2)
        this.disk(cx + Math.cos(a) * r, cy + Math.sin(a) * r, lw / 2, c)
      }
    }
  }

  /** 实心多边形（扫描线） */
  fillPoly(points: [number, number][], c: RGB) {
    const ys = points.map((p) => p[1])
    const y0 = Math.max(0, Math.floor(Math.min(...ys)))
    const y1 = Math.min(this.size - 1, Math.ceil(Math.max(...ys)))
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = []
      for (let i = 0; i < points.length; i++) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
        }
      }
      xs.sort((m, n) => m - n)
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let x = Math.round(xs[i]); x <= Math.round(xs[i + 1]); x++) this.px(x, y, c)
      }
    }
  }

  toImageData(): ImageData {
    // TS 的 ImageData 构造要求底层是 ArrayBuffer（不含 SharedArrayBuffer 联合），这里显式收窄
    return new ImageData(this.buf as unknown as Uint8ClampedArray<ArrayBuffer>, this.size, this.size)
  }
}

/** 框形（GJB：我方=矩形、敌方=菱形、中立=方块、不明=圆角） */
function frameOf(aff: SymbolAffiliation) {
  switch (aff) {
    case 'hostile': return { poly: [[16, 2], [30, 16], [16, 30], [2, 16]] as [number, number][], rect: null }
    case 'neutral': return { poly: null, rect: [3, 3, 26, 26, 0] as [number, number, number, number, number] }
    case 'unknown': return { poly: null, rect: [3, 3, 26, 26, 6] as [number, number, number, number, number] }
    case 'friend':
    default: return { poly: null, rect: [2, 8, 28, 16, 0] as [number, number, number, number, number] }
  }
}

/** 某符号的像素绘制函数（图形部分） */
const PAINTER: Record<string, (r: Raster, c: RGB) => void> = {
  infantry: (r, c) => { r.line(8, 12, 24, 20, c, 1.6); r.line(24, 12, 8, 20, c, 1.6) },
  armor: (r, c) => r.ellipse(16, 16, 8.5, 4.5, c, 1.6),
  artillery: (r, c) => r.disk(16, 16, 3.2, c),
  missile: (r, c) => r.fillPoly([[16, 9], [21, 22], [16, 19], [11, 22]], c),
  radar: (r, c) => { r.circle(16, 19, 3, c, 1.5); r.line(16, 19, 23, 12, c, 1.5); r.line(16, 19, 9, 12, c, 1.2) },
  command: (r, c) => { r.line(13, 9, 13, 23, c, 1.6); r.fillPoly([[13, 10], [22, 13], [13, 16]], c) },
  recon: (r, c) => { r.ellipse(16, 16, 7.5, 4.5, c, 1.4); r.disk(16, 16, 2.2, c) },
  ew: (r, c) => r.fillPoly([[18, 8], [12, 17], [16, 17], [14, 24], [21, 14], [17, 14]], c),
  logistics: (r, c) => { r.rect(11, 11, 10, 10, c, 1.5); r.line(11, 16, 21, 16, c, 1); r.line(16, 11, 16, 21, c, 1) },
  medical: (r, c) => { r.line(16, 10, 16, 22, c, 3); r.line(10, 16, 22, 16, c, 3) },
  aviation: (r, c) => { r.line(16, 8, 16, 24, c, 1.6); r.line(9, 15, 23, 15, c, 1.6); r.line(11, 20, 21, 20, c, 1.6) },
  uav: (r, c) => { r.poly([[16, 21], [10, 10], [22, 10]], c, 1.6); r.line(10, 10, 22, 10, c, 2) },
}

/**
 * 生成符号图像（同步，可直接交给 map.addImage）。
 * 自定义符号（宿主注册的 svg 字符串）无法逐像素栅格化，退回"通用方框 + 中心点"，
 * 并在控制台提示一次——要精细自定义请改用内置符号或提 issue 扩展 PAINTER。
 */
const customWarned = new Set<string>()
export function rasterizeSymbol(key: string, aff: SymbolAffiliation, colorHex: string): ImageData {
  const r = new Raster(32)
  const c = hexToRgb(colorHex)
  const f = frameOf(aff)
  if (f.poly) r.poly(f.poly, c, 1.6)
  else if (f.rect) r.rect(f.rect[0], f.rect[1], f.rect[2], f.rect[3], c, 1.6, f.rect[4])
  const paint = PAINTER[key]
  if (paint) paint(r, c)
  else {
    if (!customWarned.has(key)) {
      customWarned.add(key)
      console.warn(`[map-2d] 自定义符号 ${key} 暂无像素绘制实现，使用占位图形（框+点）`)
    }
    r.disk(16, 16, 3, c)
  }
  return r.toImageData()
}
