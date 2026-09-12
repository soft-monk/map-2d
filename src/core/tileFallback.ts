// map-2d · 瓦片源自动降级（需求 M2-MAP-10）
//
// 场景：本地瓦片服务没起、路径配错、或网络中断 → 底图整片空白。
// 期望：**地图保持可用**（可拖拽、可画图元、可切底图），并**明确告知已降级**，而不是默默白屏。
//
// 判定：监听地图的瓦片错误事件，滑动窗口内错误比例过高即判定"源不可用"；
//       若窗口内一张都没成功加载，也判为不可用。
// 动作：① 广播 `map2d:tiles-degraded` 事件（宿主可提示用户）
//       ② 在降级状态里记录原因与计数（宿主可查询）
//       ③ 底图本就带纯色兜底（M2-BASE-03/04），模块不改样式、不中断交互
// 恢复：窗口内重新出现成功加载 → 自动解除降级并广播恢复事件。
import type { Map as MlMap } from 'maplibre-gl'
import { mapInstance } from './instance'
import { installTileNetworkHook, tileNetStats, resetTileNetStats } from './tileNet'

export interface TileDegradeState {
  /** 是否处于降级（瓦片源不可用） */
  degraded: boolean
  /** 判定原因（可读） */
  reason: string
  /** 窗口内错误数 / 成功数 */
  errors: number
  loaded: number
  /** 判定时间戳（毫秒） */
  at: number
  /** 出错的瓦片 URL 样例（最多 5 条，供排障） */
  samples: string[]
}

export const TILES_DEGRADED_EVENT = 'map2d:tiles-degraded'

/** 判定窗口（毫秒） */
const WINDOW_MS = 5000
/** 窗口内错误数达到该值且错误率超过阈值 → 降级 */
const ERROR_COUNT_THRESHOLD = 6
const ERROR_RATE_THRESHOLD = 0.6
/** 窗口内至少有这么多张瓦片成功加载，才认为源是健康的 */
const MIN_LOADS_TO_BE_HEALTHY = 3

let errors: number[] = []
let loaded: number[] = []
let samples: string[] = []
let degraded = false
let reason = ''
let at = 0
let bound: MlMap | null = null
let timer = 0

function prune(now: number) {
  errors = errors.filter((t) => now - t <= WINDOW_MS)
  loaded = loaded.filter((t) => now - t <= WINDOW_MS)
  if (!errors.length) samples = []
}

function broadcast() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(TILES_DEGRADED_EVENT, { detail: tileState() }))
}

function evaluate() {
  // 判定依据改为**网络层的真实瓦片请求计数**（core/tileNet）。
  // 不再用渲染器的 sourcedata —— 那是逐瓦片进度事件，每秒上千次，
  // 会把"成功数"抬得极高，使降级条件永远不成立（第八轮实测发现）。
  const net = tileNetStats()
  const e = net.fail
  const l = net.ok
  const total = e + l
  const rate = total ? e / total : 0

  let nextDegraded = degraded
  let nextReason = reason

  if (e >= ERROR_COUNT_THRESHOLD && l < MIN_LOADS_TO_BE_HEALTHY) {
    nextDegraded = true
    nextReason = '最近 ' + Math.round(WINDOW_MS / 1000) + ' 秒内 ' + e + ' 次瓦片请求失败，仅 ' + l + ' 次成功，判定瓦片源不可用'
      + (rate > 0 ? '（错误率 ' + (rate * 100).toFixed(0) + '%）' : '')
      + (net.lastError ? '；最后一次失败：' + net.lastError : '')
    if (net.samples.length) samples = [...net.samples]
  } else if (degraded && l >= MIN_LOADS_TO_BE_HEALTHY && rate < ERROR_RATE_THRESHOLD) {
    nextDegraded = false
    nextReason = ''
  }

  if (nextDegraded !== degraded) {
    degraded = nextDegraded
    reason = nextReason
    at = Date.now()
    if (degraded) {
      console.warn('[map-2d] 瓦片源降级：' + reason + '。地图保持可用（纯色兜底），已广播 ' + TILES_DEGRADED_EVENT + ' 事件。'
        + ' 排查建议：确认瓦片服务已启动、模板路径正确（默认 /tiles/raster/{z}/{x}/{y}.jpg）。')
    } else {
      console.info('[map-2d] 瓦片源已恢复，退出降级状态。')
    }
    broadcast()
  }
}
/** 绑定到地图（MapView 在 load 后调用一次） */
export function bindTileFallback(map: MlMap) {
  if (bound === map) return
  bound = map
  installTileNetworkHook()   // 网络层挂钩：统计真实瓦片请求成败（M2-MAP-10）

  map.on('error', (e: unknown) => {
    const err = e as { error?: { message?: string; url?: string }; sourceId?: string; tile?: { tileID?: string } }
    const msg = err?.error?.message ?? ''
    const srcId = err?.sourceId ?? ''
    // 只关心底图瓦片相关的错误；样式/图层错误另有处理
    const isTile = !!err?.tile || /tile|image|fetch|NetworkError|404/i.test(msg)
    if (!isTile) return
    errors.push(performance.now())
    const url = err?.error?.url ?? (err?.tile?.tileID ? `tile ${err.tile.tileID}` : '')
    if (url && !samples.includes(url) && samples.length < 5) samples.push(url)
    if (!srcId || srcId.includes('base')) evaluate()
  })

  // 成功加载：MapLibre 的 sourcedata 会在瓦片到位时触发
  // 注：成功/失败计数已由网络层负责（core/tileNet），此处不再重复统计。

  // 周期性评估：即使不再有新请求，也能在窗口滑过后解除降级
  if (timer) window.clearInterval(timer)
  timer = window.setInterval(evaluate, 1500)
}

/** 解绑（地图销毁时） */
export function unbindTileFallback() {
  if (timer) window.clearInterval(timer)
  timer = 0
  bound = null
  errors = []
  loaded = []
  samples = []
  degraded = false
  reason = ''
  at = 0
}

/** 当前降级状态 */
export function tileState(): TileDegradeState {
  // errors/loaded 取**网络层计数**（与判定同源）；samples 也以网络层为准，
  // 避免"判定用的是网络数据、对外读的却是渲染器事件计数"这种不一致。
  const net = tileNetStats()
  return {
    degraded,
    reason,
    errors: net.fail,
    loaded: net.ok,
    at,
    samples: net.samples.length ? [...net.samples] : [...samples],
  }
}

/** 是否降级（运行指标 getStats().degraded 用它） */
export function isDegraded(): boolean {
  return degraded
}

/** 手动重置（测试/排障用） */
export function resetTileFallback() {
  resetTileNetStats()
  errors = []
  loaded = []
  samples = []
  degraded = false
  reason = ''
  at = 0
}

/** 订阅降级状态变化（宿主可据此在界面上提示"底图源不可用"） */
export function onTilesDegraded(fn: (s: TileDegradeState) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<TileDegradeState>).detail ?? tileState())
  window.addEventListener(TILES_DEGRADED_EVENT, handler)
  return () => window.removeEventListener(TILES_DEGRADED_EVENT, handler)
}

/** 让地图实例可被其它模块复用（保持单例语义） */
export function activeMap(): MlMap | null {
  return mapInstance.current
}
