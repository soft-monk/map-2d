// map-2d · 运行指标与错误上报（需求 M2-CTRL-15 / M2-NFR-10 / M2-NFR-11）
//
// 用途：
//   · stats()   —— 宿主可读的运行指标（帧率、各类图元数量、瓦片缓存量、最近一次提交耗时、JS 堆、是否降级）
//   · onError() —— 图元数据非法时上报（含 kind 与原因），配合渲染层的错误边界使用
// 说明：帧率用 requestAnimationFrame 计数得到（MapLibre 未提供公开的 FPS 接口）。
import { mapInstance } from './instance'
import type { PrimitiveKind } from '../primitives/api'

export interface PrimitiveError {
  kind: PrimitiveKind
  id: string
  reason: string
}

export interface RuntimeStats {
  /** 最近一秒的帧率（rAF 计数） */
  fps: number
  /** 各类型图元数量 */
  primitives: Partial<Record<PrimitiveKind, number>>
  /** 地图瓦片缓存中的瓦片数（取不到时为 null） */
  tileCache: number | null
  /** 最近一次图元提交耗时（ms） */
  lastSubmitMs: number
  /** JS 堆占用（MB，浏览器不支持时为 null） */
  jsHeapMB: number | null
  /** 是否处于降级状态（大数据量降级，暂未启用时为 false） */
  degraded: boolean
}

const errorHandlers = new Set<(e: PrimitiveError) => void>()
const errors: PrimitiveError[] = []
let lastSubmitMs = 0

/** 渲染层调用：记录一次图元提交耗时 */
export function recordSubmit(ms: number) {
  lastSubmitMs = ms
}

/** 渲染层调用：上报一条非法图元（不中断其它图元渲染） */
export function reportPrimitiveError(e: PrimitiveError) {
  if (errors.length < 50) errors.push(e)
  for (const fn of [...errorHandlers]) {
    try { fn(e) } catch { /* 单个回调异常不影响其他 */ }
  }
}

/** 订阅图元错误；返回取消订阅函数 */
export function onPrimitiveError(fn: (e: PrimitiveError) => void): () => void {
  errorHandlers.add(fn)
  return () => { errorHandlers.delete(fn) }
}

/** 最近上报的错误（最多保留 50 条） */
export function recentErrors(): PrimitiveError[] {
  return [...errors]
}

// ---- 帧率：持续用 rAF 计数，按 1 秒窗口滚动 ----
let frames = 0
let windowStart = 0
let fps = 0
let rafId = 0
let counting = false

export function startFpsCounter() {
  if (counting || typeof requestAnimationFrame !== 'function') return
  counting = true
  windowStart = performance.now()
  const tick = () => {
    frames++
    const now = performance.now()
    if (now - windowStart >= 1000) {
      fps = Math.round((frames * 1000) / (now - windowStart))
      frames = 0
      windowStart = now
    }
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
}

export function stopFpsCounter() {
  counting = false
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  fps = 0
}

/** 图元数量统计（由绘制 API 提供；未注入时该项为空） */
let primitiveCounter: (() => Partial<Record<PrimitiveKind, number>>) | null = null
export function setPrimitiveCounter(fn: () => Partial<Record<PrimitiveKind, number>>) {
  primitiveCounter = fn
}

function cacheSize(): number | null {
  const map = mapInstance.current as unknown as {
    style?: { sourceCaches?: Record<string, { _tiles?: Record<string, unknown> }> }
  } | null
  const caches = map?.style?.sourceCaches
  if (!caches) return null
  let n = 0
  for (const c of Object.values(caches)) n += Object.keys(c?._tiles ?? {}).length
  return n
}

/** 读取运行指标 */
export function stats(): RuntimeStats {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return {
    fps,
    primitives: primitiveCounter ? primitiveCounter() : {},
    tileCache: cacheSize(),
    lastSubmitMs: +lastSubmitMs.toFixed(2),
    jsHeapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    degraded: false,
  }
}

/** 清空错误记录（测试/重置用） */
export function resetDiagnostics() {
  errors.length = 0
  lastSubmitMs = 0
  fps = 0
}
