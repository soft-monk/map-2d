// map-2d · 几何与量算（需求 M2-CTRL-10 量算 / M2-DRAW-12 图元编辑 / M2-DRAW-14 吸附）
//
// 全部公式**内联实现，不引第三方依赖**（保持"整目录可拷贝"这条交付约束）：
//   · 距离：haversine（球面大圆距离）
//   · 方位角：初始方位角（initial bearing，正北为 0、顺时针）
//   · 面积：球面多边形面积（L'Huilier 三角剖分，单位 m²）
//   · 顶点访问：把 11 类图元统一映射成"可编辑顶点数组"，供编辑与吸附使用
import type { PrimitiveKind } from '../primitives/api'

const R = 6371008.8 // 地球平均半径（米）

export type LngLat = [number, number]

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** 两点球面距离（米） */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const lat1 = rad(a[1])
  const lat2 = rad(b[1])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 折线总长（米） */
export function pathLengthMeters(points: LngLat[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) sum += distanceMeters(points[i - 1], points[i])
  return sum
}

/** 点到线的最近距离（米，球面近似：按纬度换算成局部平面） */
export function pointToSegmentMeters(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = 111320 * Math.cos(rad(p[1])) // 每度经度对应米数
  const ky = 110574 // 每度纬度对应米数
  const px = p[0] * kx, py = p[1] * ky
  const ax = a[0] * kx, ay = a[1] * ky
  const bx = b[0] * kx, by = b[1] * ky
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** 初始方位角（度，正北 0、顺时针 0–360） */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const lat1 = rad(a[1])
  const lat2 = rad(b[1])
  const dLng = rad(b[0] - a[0])
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/**
 * 球面多边形面积（m²）。
 *
 * 用**环形积分**（ring integral，与 turf.js 同一套算法）：
 *   A = R² · |Σ (λ_{i+1} − λ_i) · (2 + sin φ_i + sin φ_{i+1})| / 2
 * 早期版本试图用"球面三角形内角求盈余（L'Huilier）"，但那需要每个顶点的**内角**，
 * 而用相邻面法向夹角算出来的是二面角，不是内角——实测把 0.1°×0.1° 的面积放大了 200 万倍。
 * 环形积分只需各点经纬度，数值稳定且实现短。
 */
export function polygonAreaM2(ring: LngLat[]): number {
  const pts = ring.length > 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
    ? [...ring, ring[0]]
    : ring
  if (pts.length < 4) return 0

  let total = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const [lng1, lat1] = pts[i]
    const [lng2, lat2] = pts[i + 1]
    total += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)))
  }
  return Math.abs((total * R * R) / 2)
}

// ---------------------------------------------------------------- 单位格式化

export function fmtDistance(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(1)} m`
  if (meters < 10000) return `${(meters / 1000).toFixed(2)} km`
  return `${(meters / 1000).toFixed(1)} km`
}

export function fmtArea(m2: number): string {
  if (m2 < 1e6) return `${m2.toFixed(0)} m²`
  return `${(m2 / 1e6).toFixed(2)} km²`
}

// ---------------------------------------------------------------- 顶点访问（编辑与吸附共用）

/**
 * 取出图元的可编辑顶点。
 * 说明：11 类图元形状不同——区域是环、航线和轨迹是折线、其余是单点。
 * 统一映射成顶点数组后，编辑与吸附就能用一套逻辑处理。
 */
export function verticesOf(kind: PrimitiveKind, item: Record<string, unknown>): LngLat[] {
  switch (kind) {
    case 'area':
      return ((item.polygon as LngLat[] | undefined) ?? []).map((p) => [p[0], p[1]])
    case 'route':
    case 'track':
      return ((item.points as LngLat[] | undefined) ?? []).map((p) => [p[0], p[1]])
    case 'link':
      return [item.from as LngLat, item.to as LngLat].filter(Boolean) as LngLat[]
    case 'shape':
      return [[item.lng as number, item.lat as number]]
    case 'drone':
    case 'target':
    case 'cluster':
    case 'label':
    case 'scan':
    case 'pulse':
      return [[item.lng as number, item.lat as number]]
    default:
      return []
  }
}

/** 用新的顶点数组生成更新后的图元对象（不改动其它字段） */
export function withVertices(kind: PrimitiveKind, item: Record<string, unknown>, pts: LngLat[]): Record<string, unknown> {
  switch (kind) {
    case 'area':
      return { ...item, polygon: pts }
    case 'route':
    case 'track':
      return { ...item, points: pts }
    case 'link':
      return { ...item, from: pts[0], to: pts[1] }
    case 'shape':
    case 'drone':
    case 'target':
    case 'cluster':
    case 'label':
    case 'scan':
    case 'pulse':
      return { ...item, lng: pts[0][0], lat: pts[0][1] }
    default:
      return item
  }
}

/** 该类型的顶点是否可由用户自由增删（区域/航线/轨迹是折线或环；link 只有两端；其余是单点） */
export function isEditableShape(kind: PrimitiveKind): boolean {
  return kind === 'area' || kind === 'route' || kind === 'track'
}

/**
 * 在折线/环的指定段后插入一个顶点。
 * 环（area）插入后保持闭合语义由渲染层负责，这里只处理顶点数组。
 */
export function insertVertex(pts: LngLat[], segIndex: number, p: LngLat): LngLat[] {
  const out = [...pts]
  out.splice(segIndex + 1, 0, p)
  return out
}

/** 删除顶点（区域至少保留 3 个、折线至少保留 2 个） */
export function removeVertex(pts: LngLat[], index: number, min: number): LngLat[] {
  if (pts.length <= min) return pts
  return pts.filter((_, i) => i !== index)
}

/**
 * **找最近候选点**：在候选点里找离目标最近、且距离小于阈值的那个点  两个用途共用：
 * `thresholdMeters` 由调用方按屏幕像素换算而来（见 DrawLayer 的顶点拖拽）。
 *
 * ★ 2026-09-18（用户："点上面有吸附功能？没必要，可以删除该功能"）：
 *   这里原先是 `snapTo()` —— **绘制时的光标吸附**，模块会把你点的位置吸到附近的已有点上，
 *   并在屏幕上画一个吸附标记 + 提示「吸附到 …」。那个功能**已整条删除**。
 *   本函数保留下来，只服务**顶点拖拽的命中检测**（"按下的是哪个手柄"）—— 那不是吸附，
 *   去掉它顶点就拖不动了。名字改成 `nearestWithin` 以免与已删的吸附混淆。
 *
 *  2026-09-20（按新需求恢复吸附）：它同时是**绘制落点 / 顶点拖拽的吸附判定**
 *   （`DrawLayer` 用 `SNAP_PX` 阈值调用它），也仍是**顶点手柄的命中检测**（`HANDLE_PX` 阈值）。
 */
export function nearestWithin(
  target: LngLat,
  candidates: { point: LngLat; label?: string }[],
  thresholdMeters: number,
): { point: LngLat; label?: string; distance: number } | null {
  let best: { point: LngLat; label?: string; distance: number } | null = null
  for (const c of candidates) {
    const d = distanceMeters(target, c.point)
    if (d <= thresholdMeters && (!best || d < best.distance)) best = { point: c.point, label: c.label, distance: d }
  }
  return best
}
