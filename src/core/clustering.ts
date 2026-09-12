// map-2d · 聚合与标签策略（需求 M2-DRAW-10 目标聚合 / M2-DRAW-11 标签避让与分级）
//
// 两者都作用于"渲染前的数据"，且都由缩放驱动，所以放在一起。
//
// 【目标聚合 M2-DRAW-10】
//   思路：按**屏幕像素距离**聚类——同一个屏幕格子里的点合成一个计数气泡。
//   为什么用像素而不是地理距离：用户看到的是屏幕；低缩放下 5km 内的点在屏幕上就是挤成一团，
//   而高缩放下同样 5km 已经分得很开。像素口径天然随缩放变化，不用维护"每级阈值表"。
//   聚类用网格法（snap-to-grid），O(n)，并迭代合并直到没有相邻簇（避免相邻格子各成一簇的抖动）。
//
// 【标签避让与分级 M2-DRAW-11】
//   避让：交给 MapLibre 的符号碰撞检测（text-allow-overlap=false，已开启）——
//         它会自动隐藏压在一起的标签，这是渲染器内建能力，比自己算矩形相交更准。
//   分级：模块给"按缩放决定哪些标签该出现"的策略——图元可声明 `minZoom`，
//         低于该层级不出现；也可整体按"显示前 N 个"限制。
import type { PrimitiveKind } from '../primitives/api'

// ---------------------------------------------------------------- 聚合

export interface ClusterOptions {
  /** 是否启用聚合（默认 false，保持原有点位语义） */
  enabled?: boolean
  /** 聚合的屏幕像素半径（默认 42px） */
  radiusPx?: number
  /** 对哪些类型生效（默认 ['target']） */
  kinds?: PrimitiveKind[]
  /** 低于该缩放才聚合（默认 13：放大到 13 级以后自然散开） */
  maxZoom?: number
}

export const clusterOptions: Required<ClusterOptions> = {
  enabled: false,
  radiusPx: 42,
  kinds: ['target'],
  maxZoom: 13,
}

export function setClusterOptions(opts: ClusterOptions) {
  Object.assign(clusterOptions, opts)
  return { ...clusterOptions }
}

export function getClusterOptions(): Required<ClusterOptions> {
  return { ...clusterOptions }
}

/** 聚合结果（供宿主查询与调试） */
export interface ClusterStats {
  /** 参与聚合的原始点数 */
  input: number
  /** 聚合后剩下的点数（气泡 + 单点） */
  output: number
  /** 当前是否真的在聚合（受 enabled 与 maxZoom 影响） */
  active: boolean
}

let lastStats: ClusterStats = { input: 0, output: 0, active: false }

export function clusterStats(): ClusterStats {
  return { ...lastStats }
}

/** 渲染层调用：未做聚合时也同步一次统计（保持"当前是否在聚合"这一口径准确） */
export function setClusterStats(s: ClusterStats) {
  lastStats = { ...s }
}

interface XY { x: number; y: number }

/**
 * 网格聚类：把屏幕坐标落到 radiusPx 的格子里，同格合并；再迭代合并相邻格，直到稳定。
 * 返回：每个簇的代表点下标数组 + 簇内元素下标。
 */
function gridCluster(points: XY[], radiusPx: number): number[][] {
  if (!points.length) return []
  const cell = Math.max(1, radiusPx)
  const buckets = new Map<string, number[]>()
  for (let i = 0; i < points.length; i++) {
    const key = `${Math.floor(points[i].x / cell)},${Math.floor(points[i].y / cell)}`
    const arr = buckets.get(key)
    if (arr) arr.push(i)
    else buckets.set(key, [i])
  }

  // 迭代合并：把"与已有簇质心距离 < radiusPx"的格子并入（含对角相邻格）
  let clusters = [...buckets.values()]
  let merged = true
  let guard = 0
  while (merged && guard++ < 12) {
    merged = false
    const next: number[][] = []
    const centroids: XY[] = []
    for (const cl of clusters) {
      const c = centroid(cl, points)
      let hit = -1
      for (let k = 0; k < centroids.length; k++) {
        if (Math.hypot(c.x - centroids[k].x, c.y - centroids[k].y) < cell) { hit = k; break }
      }
      if (hit >= 0) {
        next[hit].push(...cl)
        centroids[hit] = centroid(next[hit], points)
        merged = true
      } else {
        next.push(cl)
        centroids.push(c)
      }
    }
    clusters = next
  }
  return clusters
}

function centroid(idxs: number[], points: XY[]): XY {
  let sx = 0
  let sy = 0
  for (const i of idxs) { sx += points[i].x; sy += points[i].y }
  return { x: sx / idxs.length, y: sy / idxs.length }
}

/**
 * 聚合入口：输入原始点（含屏幕坐标与图元数据），输出"要渲染的点"。
 * 单点簇保持原样；多点簇转成 cluster 图元（计数气泡）。
 */
export function clusterPoints<T extends { lng: number; lat: number }>(
  items: T[],
  project: (lng: number, lat: number) => XY,
  zoom: number,
): {
  /** 不参与聚合的单点（原样渲染） */
  singles: T[]
  /** 聚合出来的气泡 */
  bubbles: { lng: number; lat: number; count: number; ids: number[] }[]
  stats: ClusterStats
} {
  const active = clusterOptions.enabled && zoom <= clusterOptions.maxZoom
  if (!active || items.length < 2) {
    lastStats = { input: items.length, output: items.length, active: false }
    return { singles: items, bubbles: [], stats: lastStats }
  }

  const xy = items.map((it) => project(it.lng, it.lat))
  const clusters = gridCluster(xy, clusterOptions.radiusPx)

  const singles: T[] = []
  const bubbles: { lng: number; lat: number; count: number; ids: number[] }[] = []
  for (const cl of clusters) {
    if (cl.length === 1) {
      singles.push(items[cl[0]])
    } else {
      let lng = 0
      let lat = 0
      for (const i of cl) { lng += items[i].lng; lat += items[i].lat }
      bubbles.push({ lng: lng / cl.length, lat: lat / cl.length, count: cl.length, ids: cl })
    }
  }
  lastStats = { input: items.length, output: singles.length + bubbles.length, active: true }
  return { singles, bubbles, stats: lastStats }
}

// ---------------------------------------------------------------- 标签分级

export interface LabelPolicy {
  /** 是否启用分级（默认 false） */
  enabled?: boolean
  /** 全图最多显示多少个标签（0 或未设 = 不限） */
  maxLabels?: number
  /** 默认最低缩放（图元自身 minZoom 优先） */
  minZoom?: number
}

const labelPolicy: Required<LabelPolicy> = { enabled: false, maxLabels: 0, minZoom: 0 }

/** 供渲染层读取当前标签策略（别名，避免与 setLabelPolicy 混淆） */
export const labelOptions = labelPolicy

export function setLabelPolicy(p: LabelPolicy) {
  Object.assign(labelPolicy, p)
  return { ...labelPolicy }
}

export function getLabelPolicy(): Required<LabelPolicy> {
  return { ...labelPolicy }
}

/**
 * 按当前缩放过滤标签。
 * 规则（按优先级）：
 *   1. 图元自带 `minZoom` 且当前 zoom 更小 → 不显示；
 *   2. 启用了分级时套用策略默认 `minZoom`；
 *   3. 仍超过 `maxLabels` → 按 zoom 降序……（没有优先级字段时按数组顺序截断）
 */
export function filterLabels<T extends { minZoom?: number }>(labels: T[], zoom: number): { shown: T[]; hidden: number } {
  // 逐条分级：图元自带 minZoom 优先，否则用策略默认值（0 = 不限制）。
  // 注意：分级**不需要**先启用策略——只要图元写了 minZoom 就该按它生效；
  // `enabled` 只控制"数量上限"这一条策略。
  const defaultMin = labelPolicy.minZoom ?? 0
  let out = labels.filter((l) => zoom >= (l.minZoom ?? defaultMin))
  if (labelPolicy.enabled && labelPolicy.maxLabels > 0 && out.length > labelPolicy.maxLabels) {
    return { shown: out.slice(0, labelPolicy.maxLabels), hidden: out.length - labelPolicy.maxLabels }
  }
  return { shown: out, hidden: labels.length - out.length }
}
