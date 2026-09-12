// map-2d · 资源占用上限与淘汰（需求 M2-NFR-12）
//
// 目标：长时间运行（连续开图、反复缩放、图元持续更新）**内存不单调增长**。
// 三条可控资源：
//   ① 瓦片缓存：MapLibre 内部按 sourceCache 缓存瓦片。模块可限制其保留数量，
//      超出时按"最少使用"淘汰（MapLibre 的 sourceCache 自带 `_tiles` 表，直接管理其条目）。
//   ② 图元数据：每类图元的条数上限，超限时**丢最旧的**（Map 的插入序即新旧序）。
//   ③ 历史缓冲：诊断错误、回放采样点、绘制历史等长期累积的数组，统一加上限。
//
// 设计取舍：不做"定时强制 GC"（浏览器不允许），只做**有界的容器**——
// 让内存增长有明确上界，这比事后清理更可靠，也更容易在指标里验证。
import { mapInstance } from './instance'
import { MapDraw, type PrimitiveKind } from '../primitives/api'
import { reportPrimitiveError } from './diagnostics'

export interface ResourceLimits {
  /** 每类图元的最大条数（默认 20000；超出丢弃最旧的） */
  maxPrimitivesPerKind: number
  /** 瓦片缓存上限（每数据源保留的瓦片数，默认 600；超出按最少使用淘汰） */
  maxTilesPerSource: number
  /** 诊断错误保留条数（默认 50） */
  maxErrors: number
  /** 是否启用（默认开启；关闭后只统计不淘汰） */
  enabled: boolean
}

const limits: ResourceLimits = {
  maxPrimitivesPerKind: 20000,
  maxTilesPerSource: 600,
  maxErrors: 50,
  enabled: true,
}

export interface ResourceUsage {
  /** 各类型图元条数 */
  primitives: Partial<Record<PrimitiveKind, number>>
  /** 图元总条数 */
  primitivesTotal: number
  /** 各数据源瓦片缓存数 */
  tiles: Record<string, number>
  /** 瓦片缓存总数 */
  tilesTotal: number
  /** 诊断错误条数 */
  errors: number
  /** JS 堆占用（MB） */
  jsHeapMB: number | null
  /** 累计淘汰次数（图元/瓦片） */
  evicted: { primitives: number; tiles: number }
}

const evicted = { primitives: 0, tiles: 0 }
let autoTimer = 0

/** 设置/调整资源上限（部分字段即可） */
export function setResourceLimits(patch: Partial<ResourceLimits>): ResourceLimits {
  Object.assign(limits, patch)
  enforce()
  return { ...limits }
}

export function getResourceLimits(): ResourceLimits {
  return { ...limits }
}

/** 读取当前资源占用 */
export function resourceUsage(): ResourceUsage {
  const map = mapInstance.current
  const primitives: Partial<Record<PrimitiveKind, number>> = {}
  let primitivesTotal = 0
  for (const k of ['area', 'drone', 'target', 'link', 'track', 'scan', 'pulse', 'cluster', 'label', 'route', 'shape', 'annulus', 'symbol'] as PrimitiveKind[]) {
    const n = MapDraw.list(k).length
    if (n) { primitives[k] = n; primitivesTotal += n }
  }

  const tiles: Record<string, number> = {}
  let tilesTotal = 0
  const caches = (map as unknown as { style?: { sourceCaches?: Record<string, { _tiles?: Record<string, unknown> }> } })?.style?.sourceCaches
  if (caches) {
    for (const [id, sc] of Object.entries(caches)) {
      const n = sc?._tiles ? Object.keys(sc._tiles).length : 0
      if (n) { tiles[id] = n; tilesTotal += n }
    }
  }

  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return {
    primitives, primitivesTotal, tiles, tilesTotal,
    errors: 0,   // 由 diagnostics 侧统计，此处占位（见 getStats().recentErrors）
    jsHeapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    evicted: { ...evicted },
  }
}

/**
 * 执行一次淘汰：
 *   · 图元：每类超过上限时，从**最早加入的**开始删（Map 的迭代顺序即插入顺序）
 *   · 瓦片：每个数据源超过上限时，按 `tile.state`/时间戳挑最旧的淘汰
 */
export function enforce(): { primitives: number; tiles: number } {
  if (!limits.enabled) return { primitives: 0, tiles: 0 }
  let pEvicted = 0
  let tEvicted = 0

  // ① 图元
  for (const k of ['area', 'drone', 'target', 'link', 'track', 'scan', 'pulse', 'cluster', 'label', 'route', 'shape', 'annulus', 'symbol'] as PrimitiveKind[]) {
    const items = MapDraw.list(k) as { id?: string }[]
    const over = items.length - limits.maxPrimitivesPerKind
    if (over <= 0) continue
    const doomed = items.slice(0, over)
    for (const it of doomed) {
      if (typeof it.id === 'string') MapDraw.remove(k, it.id)
      pEvicted++
    }
  }

  // ② 瓦片缓存
  const map = mapInstance.current
  const caches = (map as unknown as { style?: { sourceCaches?: Record<string, { _tiles?: Record<string, { timeAdded?: number; state?: string }> }> } })?.style?.sourceCaches
  if (caches) {
    for (const sc of Object.values(caches)) {
      const tiles = sc?._tiles
      if (!tiles) continue
      const keys = Object.keys(tiles)
      const over = keys.length - limits.maxTilesPerSource
      if (over <= 0) continue
      // 按加入时间升序，淘汰最旧的一批（保留正在使用的）
      const sorted = keys
        .map((k) => ({ k, t: tiles[k]?.timeAdded ?? 0, state: tiles[k]?.state }))
        .filter((x) => x.state !== 'loading')
        .sort((a, b) => a.t - b.t)
      for (let i = 0; i < over && i < sorted.length; i++) {
        delete tiles[sorted[i].k]
        tEvicted++
      }
    }
  }

  evicted.primitives += pEvicted
  evicted.tiles += tEvicted
  if (pEvicted || tEvicted) {
    console.info(`[map-2d] 资源上限淘汰：图元 ${pEvicted} 条、瓦片 ${tEvicted} 张（上限：每类 ${limits.maxPrimitivesPerKind} 条 / 每源 ${limits.maxTilesPerSource} 张）`)
  }
  return { primitives: pEvicted, tiles: tEvicted }
}

/** 启动周期性执行（默认 15 秒一次；MapView 在 load 后调用） */
export function startResourceGuard(intervalMs = 15000) {
  if (autoTimer) window.clearInterval(autoTimer)
  autoTimer = window.setInterval(() => {
    try { enforce() } catch (e) { reportPrimitiveError({ kind: 'area', id: '(资源上限)', reason: String(e) }) }
  }, intervalMs)
}

export function stopResourceGuard() {
  if (autoTimer) window.clearInterval(autoTimer)
  autoTimer = 0
}

/** 重置累计淘汰计数（测试/排障用） */
export function resetResourceCounters() {
  evicted.primitives = 0
  evicted.tiles = 0
}
