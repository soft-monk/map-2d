// map-2d · 圈层类图元（需求 M2-DRAW-09）
//
// 四类：距离环（等距圈）、方位线（射线）、方位圈（带刻度的圈）、九宫格参考线。
// 设计取舍：这些是**线状几何**，不填充——所以没有塞进 `shape`（圆形/椭圆区域是"面"），
// 而是新增一类 `annulus`（线状圈层），带自己的数据源与图层。
// 半径统一用**公里**表达（与扫描/圆形区域同一地理尺度语义）。
import type { LngLat } from './geometry'

/** 距离环 / 方位圈 / 方位线 / 九宫格 */
export type AnnulusKind = 'ring' | 'bearing-ring' | 'bearing-line' | 'grid'

export interface AnnulusItem {
  id: string
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15） */
  style?: string
  kind: AnnulusKind
  lng: number
  lat: number
  /** ring / bearing-ring：半径列表（公里），可给多个画出同心圈 */
  radiusKm?: number
  radiusKmList?: number[]
  /** bearing-line：方位角（度，正北 0、顺时针）；bearing-ring：刻度间隔（度，默认 30） */
  bearing?: number
  /** bearing-line 的线长（公里，默认取 radiusKm 或 10km） */
  lengthKm?: number
  /** grid：九宫格边长（公里）；rows/cols 默认 3×3 */
  rows?: number
  cols?: number
  color?: string
  weight?: number
  /** 是否虚线 */
  dashed?: boolean
  label?: string
}

const R = 6371.0088
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** 由中心 + 半径（公里）生成圆环折线（按纬度换算经度方向的度数） */
export function circleRing(center: LngLat, radiusKm: number, segments = 96): LngLat[] {
  const cosLat = Math.max(1e-6, Math.cos(rad(center[1])))
  const out: LngLat[] = []
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2
    const east = Math.cos(t) * radiusKm
    const north = Math.sin(t) * radiusKm
    out.push([center[0] + deg(east / (R * cosLat)), center[1] + deg(north / R)])
  }
  return out
}

/** 由中心 + 方位角 + 长度生成射线（起点为中心） */
export function bearingRay(center: LngLat, bearingDegrees: number, lengthKm: number): LngLat[] {
  const b = rad(bearingDegrees)
  const north = Math.cos(b) * lengthKm
  const east = Math.sin(b) * lengthKm
  const cosLat = Math.max(1e-6, Math.cos(rad(center[1])))
  return [center, [center[0] + deg(east / (R * cosLat)), center[1] + deg(north / R)]]
}

/** 九宫格参考线：中心 + 边长（公里）× 行列数 → 若干条互相垂直的短线 */
export function gridLines(center: LngLat, sideKm: number, rows: number, cols: number): LngLat[][] {
  const cosLat = Math.max(1e-6, Math.cos(rad(center[1])))
  const halfW = (sideKm * cols) / 2
  const halfH = (sideKm * rows) / 2
  const toLng = (eastKm: number) => center[0] + deg(eastKm / (R * cosLat))
  const toLat = (northKm: number) => center[1] + deg(northKm / R)

  const lines: LngLat[][] = []
  // 竖线（沿北向）
  for (let c = 0; c <= cols; c++) {
    const east = -halfW + c * sideKm
    lines.push([[toLng(east), toLat(-halfH)], [toLng(east), toLat(halfH)]])
  }
  // 横线（沿东向）
  for (let r = 0; r <= rows; r++) {
    const north = -halfH + r * sideKm
    lines.push([[toLng(-halfW), toLat(north)], [toLng(halfW), toLat(north)]])
  }
  return lines
}

/** 方位圈：整圆 + 每 step 度的刻度短线 */
export function bearingRingTicks(center: LngLat, radiusKm: number, stepDeg = 30, tickKm = 0.12): LngLat[][] {
  const out: LngLat[][] = []
  for (let a = 0; a < 360; a += stepDeg) {
    const outer = bearingRay(center, a, radiusKm)
    const inner = bearingRay(center, a, Math.max(0.01, radiusKm - tickKm * radiusKm))
    out.push([inner[1], outer[1]])
  }
  return out
}

/** 把一条圈层图元展开成若干条折线（渲染层按 LineString 画） */
export function annulusToLines(item: AnnulusItem): LngLat[][] {
  const center: LngLat = [item.lng, item.lat]
  switch (item.kind) {
    case 'ring': {
      const radii = item.radiusKmList ?? (item.radiusKm != null ? [item.radiusKm] : [])
      return radii.filter((r) => r > 0).map((r) => circleRing(center, r))
    }
    case 'bearing-ring': {
      const radii = item.radiusKmList ?? (item.radiusKm != null ? [item.radiusKm] : [])
      const rings = radii.filter((r) => r > 0).map((r) => circleRing(center, r))
      const ticks = radii.filter((r) => r > 0).flatMap((r) => bearingRingTicks(center, r, item.bearing ?? 30))
      return [...rings, ...ticks]
    }
    case 'bearing-line': {
      const len = item.lengthKm ?? item.radiusKm ?? 10
      return [bearingRay(center, item.bearing ?? 0, len)]
    }
    case 'grid':
      return gridLines(center, item.radiusKm ?? 1, item.rows ?? 3, item.cols ?? 3)
    default:
      return []
  }
}
