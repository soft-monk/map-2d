// map-2d · 大数据量降级（需求 M2-NFR-13）
//
// 目标：图元数量超过阈值时**按需降级**（抽稀/聚合/简化几何），保证仍可交互，
// 并且**明确告知已降级**（不能悄悄丢数据让用户以为画全了）。
//
// 三种降级手段（按"信息损失从小到大"依次启用）：
//   ① 抽稀（sampling）：按固定步长保留一部分图元——用于同类密集点（如无人机群）。
//   ② 简化几何（simplify）：折线/多边形按道格拉斯-普克简化（容差按屏幕像素换算），
//      用于超长轨迹（几千个点）。
//   ③ 标签/文字降级：数量超阈值时只保留前 N 个标签（复用 M2-DRAW-11 的数量上限策略）。
//
// 设计取舍：降级在**渲染入口**做，不改动图元集合——因此 list()/export() 永远是全量，
// 只有"画出来的"被降级。这样宿主的数据不会被悄悄破坏。
import { mapInstance } from './instance'
import { reportPrimitiveError } from './diagnostics'

export interface DegradePolicy {
  /** 是否启用（默认开启） */
  enabled: boolean
  /** 超过该条数开始抽稀（默认 8000） */
  threshold: number
  /** 抽稀后最多渲染多少条（默认 threshold 的一半） */
  target: number
  /** 折线/多边形顶点超过该数时简化（默认 600） */
  simplifyVertexThreshold: number
  /** 简化容差（屏幕像素，默认 1.2） */
  simplifyTolerancePx: number
}

const policy: DegradePolicy = {
  enabled: true,
  threshold: 8000,
  target: 4000,
  simplifyVertexThreshold: 600,
  simplifyTolerancePx: 1.2,
}

export interface DegradeState {
  /** 当前是否有降级生效 */
  active: boolean
  /** 触发降级的原因描述（可读） */
  reasons: string[]
  /** 原始 / 实际渲染 条数（抽稀口径） */
  input: number
  output: number
  /** 被简化的几何条数与省掉的顶点数 */
  simplified: number
  removedVertices: number
}

let state: DegradeState = { active: false, reasons: [], input: 0, output: 0, simplified: 0, removedVertices: 0 }
/** 累计降级次数（用于指标与排障） */
let degradeEvents = 0

export function setDegradePolicy(patch: Partial<DegradePolicy>): DegradePolicy {
  Object.assign(policy, patch)
  return { ...policy }
}

export function getDegradePolicy(): DegradePolicy {
  return { ...policy }
}

export function degradeState(): DegradeState {
  return { ...state, reasons: [...state.reasons] }
}

export function degradeEventCount(): number {
  return degradeEvents
}

export function resetDegradeState() {
  state = { active: false, reasons: [], input: 0, output: 0, simplified: 0, removedVertices: 0 }
  degradeEvents = 0
}

/** 屏幕像素 → 米（与吸附/量算同一口径） */
function pxToMeters(px: number): number {
  const map = mapInstance.current
  if (!map) return px
  const lat = map.getCenter().lat
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom())
  return mpp * px
}

/**
 * 抽稀：等步长保留，但**始终保留首尾**（避免态势边界被截断）。
 * 返回被保留的条目。
 */
export function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  const out: T[] = []
  const step = items.length / n
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)])
  const last = items[items.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

/**
 * 道格拉斯-普克折线简化（递归实现）。
 * `tolerance` 单位与坐标一致；调用方按屏幕像素换算。
 */
export function simplifyPath(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 2 || tolerance <= 0) return points

  const sqTol = tolerance * tolerance
  const sqSegDist = (p: [number, number], a: [number, number], b: [number, number]) => {
    let x = a[0]
    let y = a[1]
    let dx = b[0] - x
    let dy = b[1] - y
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
      if (t > 1) { x = b[0]; y = b[1] }
      else if (t > 0) { x += dx * t; y += dy * t }
    }
    dx = p[0] - x
    dy = p[1] - y
    return dx * dx + dy * dy
  }

  const simplifyStep = (first: number, last: number, out: number[]) => {
    let maxSq = sqTol
    let index = -1
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(points[i], points[first], points[last])
      if (sq > maxSq) { index = i; maxSq = sq }
    }
    if (index > 0) {
      if (index - first > 1) simplifyStep(first, index, out)
      out.push(index)
      if (last - index > 1) simplifyStep(index, last, out)
    }
  }

  const out: number[] = [0]
  simplifyStep(0, points.length - 1, out)
  out.push(points.length - 1)
  return out.map((i) => points[i])
}

/**
 * 降级入口：渲染前调用。
 * @param kind 图元类型（用于判断是否做几何简化）
 * @param items 待渲染条目（已是"可见"子集）
 */
export function applyDegrade<T extends Record<string, unknown>>(kind: string, items: T[]): T[] {
  if (!policy.enabled) {
    state = { active: false, reasons: [], input: items.length, output: items.length, simplified: 0, removedVertices: 0 }
    return items
  }

  const reasons: string[] = []
  let out = items
  let simplified = 0
  let removedVertices = 0

  // ① 抽稀（按条数）
  if (out.length > policy.threshold) {
    const n = Math.max(1, Math.min(policy.target, out.length))
    out = sample(out, n)
    reasons.push(`条数 ${items.length} 超过阈值 ${policy.threshold}，抽稀到 ${out.length}`)
  }

  // ② 几何简化（折线/环的顶点数）
  const tol = pxToMeters(policy.simplifyTolerancePx)
  if (tol > 0) {
    out = out.map((it) => {
      const pts = (it.points ?? it.polygon) as [number, number][] | undefined
      if (Array.isArray(pts) && pts.length > policy.simplifyVertexThreshold) {
        const simplifiedPts = simplifyPath(pts, tol)
        if (simplifiedPts.length < pts.length) {
          simplified++
          removedVertices += pts.length - simplifiedPts.length
          return { ...it, ...(it.points ? { points: simplifiedPts } : { polygon: simplifiedPts }) }
        }
      }
      return it
    })
  }
  if (simplified) reasons.push(`${simplified} 条几何被简化（顶点阈值 ${policy.simplifyVertexThreshold}，容差 ${policy.simplifyTolerancePx}px ≈ ${tol.toFixed(1)}m），省掉 ${removedVertices} 个顶点`)

  const active = reasons.length > 0
  const prevActive = state.active
  state = { active, reasons, input: items.length, output: out.length, simplified, removedVertices }

  // 状态从未降级变为降级时，记一次事件并广播（宿主可提示"已降级显示"）
  if (active && !prevActive) {
    degradeEvents++
    console.warn(`[map-2d] 渲染降级（${kind}）：${reasons.join('；')}。数据未被修改，list()/export() 仍为全量。`)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('map2d:degraded', { detail: degradeState() }))
    }
  }
  return out
}

/** 宿主可订阅降级状态（提示"当前为降级显示"） */
export function onDegraded(fn: (s: DegradeState) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<DegradeState>).detail ?? degradeState())
  window.addEventListener('map2d:degraded', handler)
  return () => window.removeEventListener('map2d:degraded', handler)
}

/** 便于排障：主动对一批数据试算降级结果（不改状态） */
export function previewDegrade(count: number, vertices = 0): { kept: number; verticesKept: number } {
  const kept = count > policy.threshold ? Math.min(policy.target, count) : count
  const verticesKept = vertices > policy.simplifyVertexThreshold
    ? Math.round(vertices * (policy.simplifyVertexThreshold / vertices) * 0.6)   // 经验值：简化后约剩 60% 阈值
    : vertices
  return { kept, verticesKept }
}

/** 错误上报用（内部） */
export function reportDegradeError(e: unknown) {
  reportPrimitiveError({ kind: 'area', id: '(降级)', reason: String(e) })
}
