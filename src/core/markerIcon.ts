// map-2d · 位图图标能力（本批新增，**纯可选**）
//
// 背景：模块原有"单位图形"只有 `registerSymbol()` 一条路——**自绘 SVG 逐像素栅格化**。
//   它没有位图入口：宿主手里已经有一张 PNG（例如机型图标、军标图片）时无法直接用。
// 本文件补上这一条：把宿主给的 PNG 加载为 MapLibre 图片，供点类图元（无人机等）使用。
//
// 三条硬约束（来自《需求文档-解耦版》的纪律）：
//   ① **只增可选能力**：不传样式配置 `setStyleConfig()` 时，渲染结果与改造前逐字节一致。
//   ② **模块不发外网请求**：只加载宿主在配置里给出的 URL（通常是同源的 /icons/...）。
//      模块不内置任何在线图床地址，也不做"猜一个默认图标"的兜底。
//   ③ **失败必须降级、不抛异常**：URL 缺失、404、解码失败、跨域失败——一律回落"画点"，
//      并把可读原因计数上报（见 iconFailureCount / iconFailures / onIconFailure）。
//
// 与 `symbols.ts` 的分工：
//   symbols.ts  —— 国军标**符号体系**（框+图形+敌我配色，模块自绘，同步栅格化）
//   markerIcon.ts —— 宿主提供的**位图图片**（异步加载，失败降级为点）
import type { Map as MlMap } from 'maplibre-gl'

/**
 * 位图图标锚点。
 * 取向与 MapLibre `icon-anchor` 一致：`center` 为几何中心，
 * `bottom` 表示"图片底边中点落在坐标点上"（图标像钉子一样站在点上）。
 */
export type IconAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** 一个机型（或一个图元）的图标定义 */
export interface MarkerIconConfig {
  /** 图标 URL；**由宿主给出**（本地 `/icons/...` 或宿主自己的在线地址）。缺失即视为"没有位图" */
  url?: string
  /** 图标像素尺寸 `[宽, 高]`；缺省 `[24, 24]` */
  sizePx?: [number, number]
  /** 锚点；缺省 `center` */
  anchor?: IconAnchor
}

/** 画点（回落）样式。字段名与 `map-style.json` 的 `drone.point` 段逐字段一致 */
export interface PointStyleConfig {
  /** 圆点半径（px）；缺省 **5**（= 模块改造前 `lyr-uav` 的取值，保证不配样式时不变） */
  radiusPx?: number
  /** 填充色；缺省按图元 `type` 走内置调色板（optical `#22d3ee` / radar `#f59e0b` / electronic `#a855f7` / comm `#22c55e`） */
  color?: string
  /** 描边色；缺省 **`#e8f1ff`**（= 模块改造前 `circle-stroke-color`，保证不配样式时不变） */
  strokeColor?: string
  /** 描边宽（px）；缺省 **1**（= 模块改造前 `circle-stroke-width`） */
  strokeWidthPx?: number
}

/** 一类图元（如无人机）的图标/画点配置，含按机型覆盖 */
export interface MarkerStyleConfig {
  /** `true` = 有 `icon.url` 时画位图；`false` = 一律画点。缺省 `false`（= 不配样式时的行为） */
  useIcon?: boolean
  icon?: MarkerIconConfig
  point?: PointStyleConfig
  /**
   * 按机型覆盖（键 = 图元的 `type`，如 `optical`/`radar`/`electronic`/`comm`）。
   * 合并规则：**逐字段浅合并**，机型段只覆盖它写了的字段，其余继承顶层。
   * （与 `map-style.json` 的 `byType` 语义一致）
   */
  byType?: Record<string, MarkerStyleConfig>
}

/** 轨迹线样式。字段名与 `map-style.json` 的 `track` 段逐字段一致 */
export interface TrackStyleConfig {
  /** 线宽（px）；缺省 **2**（= 模块改造前 `lyr-track` 的取值，保证不配样式时不变） */
  widthPx?: number
  /** 是否虚线；缺省按图元 `dashed` 字段走（图元也没给则沿用改造前的默认：虚线） */
  dashed?: boolean
  /** 线色；缺省按图元 `color`，再缺省为内置 `#ef4444` */
  color?: string
  /** 线透明度；缺省 **0.9**（= 模块改造前 `lyr-track` 的取值） */
  opacity?: number
}

/**
 * 地图样式配置（**宿主传入的可选配置**）。
 *
 * 形状与 `map-style.json` 一致，可直接把该 JSON 交给 `setStyleConfig()`：
 * 未识别的字段（`schemaVersion`/`note`/`target`/`groupColors`/…）会被忽略，
 * 因为前端宿主可能还要用它们做别的（例如按 `groupColors` 给编队配色）。
 */
export interface MapStyleConfig {
  /** 点类图元的位图图标 + 缺省画点（当前用于无人机；其它点类图元可复用同一套语义） */
  drone?: MarkerStyleConfig
  /** 轨迹线样式 */
  track?: TrackStyleConfig
  /** 其余字段原样保留，模块不解释（便于宿主复用同一份 JSON） */
  [k: string]: unknown
}

// ---------------------------------------------------------------- 解析（纯函数，便于单测）

/** 位图图标缺省尺寸（px） */
export const DEFAULT_ICON_SIZE_PX: [number, number] = [24, 24]
/** 位图图标缺省锚点 */
export const DEFAULT_ICON_ANCHOR: IconAnchor = 'center'
/** 画点缺省值 —— 与模块改造前的 `lyr-uav` 图层 paint 取值一致 */
export const DEFAULT_POINT_RADIUS_PX = 5
export const DEFAULT_POINT_STROKE_COLOR = '#e8f1ff'
export const DEFAULT_POINT_STROKE_WIDTH_PX = 1
/** 轨迹线缺省值 —— 与模块改造前的 `lyr-track` 图层 paint 取值一致 */
export const DEFAULT_TRACK_WIDTH_PX = 2
export const DEFAULT_TRACK_OPACITY = 0.9

/** 一个点图元最终的渲染决策（画位图 / 画点，两者必居其一） */
export interface MarkerRenderPlan {
  /** `'icon'` = 画位图；`'point'` = 画点 */
  mode: 'icon' | 'point'
  /** 画位图时：图片名（`map.addImage` 用的 key） */
  image?: string
  /** 画位图时：图标 URL */
  url?: string
  /** 画位图时：图标尺寸（px） */
  sizePx?: [number, number]
  /** 画位图时：锚点 */
  anchor?: IconAnchor
  /** 画点时：半径（px） */
  radiusPx: number
  /** 画点时：填充色；`undefined` = 用内置调色板按 `type` 推导（保持改造前行为） */
  color?: string
  /** 画点时：描边色 */
  strokeColor: string
  /** 画点时：描边宽（px） */
  strokeWidthPx: number
  /** 实际命中的覆盖段（`byType` 的键）；未命中为 `undefined` */
  matchedType?: string
  /** 为什么退回画点（`mode === 'point'` 时用于可读上报） */
  fallbackReason?: string
}

/** 逐字段浅合并两段机型配置：`base` 打底，`over` 只覆盖它自己写了的字段 */
function mergeMarkerConfig(base: MarkerStyleConfig | undefined, over: MarkerStyleConfig | undefined): MarkerStyleConfig {
  if (!base) return over ?? {}
  if (!over) return base
  return {
    useIcon: over.useIcon ?? base.useIcon,
    icon: (base.icon || over.icon) ? { ...base.icon, ...over.icon } : undefined,
    point: (base.point || over.point) ? { ...base.point, ...over.point } : undefined,
    // `byType` 不递归合并（语义上它只在顶层有意义）
  }
}

/**
 * 解析一个点图元的渲染方式：**位图优先，回落画点**。
 *
 * 传入 `typeOverride` 时会先按机型取 `byType[typeOverride]` 覆盖段。
 * 本函数是纯函数：只做配置解析，不碰地图、不加载图片（加载失败由调用方二次降级）。
 */
export function resolveMarkerPlan(
  item: { type?: string; color?: string; radiusPx?: number },
  cfg: MarkerStyleConfig | undefined,
  typeOverride?: string,
): MarkerRenderPlan {
  const type = typeOverride ?? item.type
  const merged = mergeMarkerConfig(cfg, type && cfg?.byType ? cfg.byType[type] : undefined)

  const p = merged.point ?? {}
  const plan: MarkerRenderPlan = {
    mode: 'point',
    radiusPx: item.radiusPx ?? p.radiusPx ?? DEFAULT_POINT_RADIUS_PX,
    // 图元自身的 color 最优先（保持"图元字段 > 模板/配置"的既有优先级）
    color: item.color ?? p.color,
    strokeColor: p.strokeColor ?? DEFAULT_POINT_STROKE_COLOR,
    strokeWidthPx: p.strokeWidthPx ?? DEFAULT_POINT_STROKE_WIDTH_PX,
    matchedType: type && cfg?.byType?.[type] ? type : undefined,
  }

  if (!merged.useIcon) {
    plan.fallbackReason = cfg ? 'useIcon=false' : '未配置样式（默认画点）'
    return plan
  }
  const url = merged.icon?.url
  if (!url) {
    plan.fallbackReason = 'icon.url 缺失'
    return plan
  }
  plan.mode = 'icon'
  plan.url = url
  plan.image = iconImageName(url)
  plan.sizePx = normalizeSize(merged.icon?.sizePx)
  plan.anchor = (merged.icon?.anchor ?? DEFAULT_ICON_ANCHOR)
  return plan
}

/** 尺寸规整：非正数/非法一律回落缺省 */
function normalizeSize(size?: [number, number]): [number, number] {
  if (!Array.isArray(size) || size.length < 2) return [...DEFAULT_ICON_SIZE_PX]
  const [w, h] = size
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [...DEFAULT_ICON_SIZE_PX]
  return [w, h]
}

/**
 * URL → MapLibre 图片名（`map.addImage` 的 key）。
 * 同一 URL 得到同一个名字，因此重复注册是幂等的；名字里不含 `#`/`?`/空格等
 * 会干扰样式的字符（用十六进制码位替换）。
 */
export function iconImageName(url: string): string {
  const safe = url.replace(/[^A-Za-z0-9._-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`)
  return `m2icon-${safe}`
}

// ---------------------------------------------------------------- 加载与失败计数

/** 一次图标加载失败的记录 */
export interface IconFailure {
  /** 图标 URL */
  url: string
  /** 可读原因（如 `HTTP 404` / `图片解码失败` / `地图未就绪`） */
  reason: string
  /** 发生在什么时候（毫秒时间戳） */
  at: number
  /** 第几次失败（从 1 开始累计） */
  count: number
}

const failures: IconFailure[] = []
const listeners = new Set<(f: IconFailure) => void>()
let totalFailures = 0
let totalLoads = 0

/** 累计的图标加载失败次数（对应"降级为点**并计数**"里的计数） */
export function iconFailureCount(): number {
  return totalFailures
}

/** 累计的图标加载成功次数 */
export function iconLoadCount(): number {
  return totalLoads
}

/** 最近的失败记录（新的在前） */
export function iconFailures(): IconFailure[] {
  return [...failures]
}

/** 订阅加载失败（返回取消订阅函数） */
export function onIconFailure(fn: (f: IconFailure) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 清空计数与记录（测试/重置用） */
export function resetIconDiagnostics(): void {
  failures.length = 0
  totalFailures = 0
  totalLoads = 0
}

function reportFailure(url: string, reason: string): void {
  totalFailures += 1
  const rec: IconFailure = { url, reason, at: Date.now(), count: totalFailures }
  failures.unshift(rec)
  if (failures.length > 50) failures.pop()
  // 不抛异常：只按次数告警（与模块里瓦片失败的口径一致）
  if (totalFailures === 1 || totalFailures % 20 === 0) {
    console.warn(`[map-2d] 位图图标加载失败累计 ${totalFailures} 次，已回落画点：${url} —— ${reason}`)
  }
  for (const fn of listeners) {
    try { fn(rec) } catch { /* 订阅者异常不影响渲染 */ }
  }
}

/** 已注册成功的图片名（按地图实例隔离） */
const registered = new WeakMap<MlMap, Set<string>>()
/** 正在加载中的 URL（避免同一张图并发加载多次） */
const inflight = new WeakMap<MlMap, Map<string, Promise<boolean>>>()

function registry(map: MlMap): Set<string> {
  let set = registered.get(map)
  if (!set) { set = new Set(); registered.set(map, set) }
  return set
}

/**
 * 确保某张位图已注册进 MapLibre（**幂等**）。
 *
 * 返回 `true` = 图片可用（本次加载成功或此前已注册）；`false` = 不可用，
 * **调用方必须回落画点**。任何失败都走 `reportFailure()` 计数，不抛异常。
 *
 * 实现方式：`map.loadImage(url, cb)` → `map.addImage(name, image)`。
 * 用 MapLibre 自带的加载器而不是 `new Image()`，是为了复用它的 abort/跨域与
 * 缓存策略，且能拿到"加载失败"的那条错误分支（`Image` 的 `onerror` 拿不到原因）。
 */
export async function ensureMarkerImage(
  map: MlMap | null | undefined,
  url: string,
  sizePx: [number, number] = DEFAULT_ICON_SIZE_PX,
): Promise<boolean> {
  if (!map) { reportFailure(url, '地图未就绪'); return false }
  const name = iconImageName(url)
  if (registry(map).has(name)) return true
  if (map.hasImage(name)) { registry(map).add(name); return true }

  let flight = inflight.get(map)
  if (!flight) { flight = new Map(); inflight.set(map, flight) }
  const running = flight.get(url)
  if (running) return running

  const task = new Promise<boolean>((resolve) => {
    try {
      // MapLibre v4 的 `loadImage` 是 **Promise 版**（没有 callback 重载）：
      // 失败时 reject。这里把它包成"永不 reject、只回 boolean"的形式——
      // 调用方拿到 false 就回落画点，不需要处理异常。
      map.loadImage(url).then(
        (res) => {
          const image = (res as { data?: unknown })?.data ?? res
          if (!image) {
            reportFailure(url, '加载结果为空')
            resolve(false)
            return
          }
          try {
            if (!map.hasImage(name)) {
              // `addImage` 需要同步拿到像素：`loadImage` 给的是**已解码**的图片，
              // 因此这个调用点不会出现"空图"问题（与 symbols.ts 里 SVG 异步解码的坑不同）。
              map.addImage(name, image as never, { pixelRatio: 1 })
            }
            registry(map).add(name)
            totalLoads += 1
            resolve(true)
          } catch (e) {
            reportFailure(url, `注册图片失败：${String((e as Error)?.message ?? e)}`)
            resolve(false)
          }
        },
        (err: unknown) => {
          reportFailure(url, describeLoadError(err))
          resolve(false)
        },
      )
    } catch (e) {
      reportFailure(url, `发起加载失败：${String((e as Error)?.message ?? e)}`)
      resolve(false)
    }
  }).finally(() => { flight!.delete(url) })

  flight.set(url, task)
  return task
}

/** 把 MapLibre 的回调错误转成一行可读原因 */
function describeLoadError(err: unknown): string {
  if (!err) return '未知错误'
  const e = err as { status?: number; statusText?: string; message?: string }
  if (typeof e.status === 'number') return `HTTP ${e.status}${e.statusText ? ` ${e.statusText}` : ''}`
  if (e.message) return e.message
  return String(err)
}

/**
 * 批量确保若干张位图已注册。
 * 返回"可用的图片名集合"——调用方据此决定哪些图元画位图、哪些回落画点。
 */
export async function ensureMarkerImages(
  map: MlMap | null | undefined,
  urls: { url: string; sizePx?: [number, number] }[],
): Promise<Set<string>> {
  const ok = new Set<string>()
  const unique = new Map<string, [number, number]>()
  for (const u of urls) if (u.url && !unique.has(u.url)) unique.set(u.url, normalizeSize(u.sizePx))
  await Promise.all([...unique.entries()].map(async ([url, size]) => {
    if (await ensureMarkerImage(map, url, size)) ok.add(iconImageName(url))
  }))
  return ok
}

// ---------------------------------------------------------------- 模块级配置

let current: MapStyleConfig | null = null
const cfgListeners = new Set<(cfg: MapStyleConfig | null) => void>()

/** 当前生效的样式配置（副本；未配置过返回 `null`） */
export function styleConfig(): MapStyleConfig | null {
  return current ? { ...current } : null
}

/**
 * 登记样式配置（幂等；返回登记后的配置副本）。
 *
 * - 传 `null` = **清除配置，回到"未配置"状态**（行为与改造前逐字节一致）。
 * - 只影响读它的渲染分支：无人机图标/画点、轨迹线宽。
 * - 登记后需要重画时调 `MapDraw.render()`（宿主一般不用管：
 *   在前端里它发生在 `<MapView style={...}>` 挂载前）。
 */
export function setStyleConfig(cfg: MapStyleConfig | null): MapStyleConfig | null {
  current = cfg ?? null
  for (const fn of cfgListeners) {
    try { fn(styleConfig()) } catch { /* 订阅者异常不影响配置本身 */ }
  }
  return styleConfig()
}

/** 订阅样式配置变化（返回取消订阅函数） */
export function onStyleConfigChange(fn: (cfg: MapStyleConfig | null) => void): () => void {
  cfgListeners.add(fn)
  return () => { cfgListeners.delete(fn) }
}

/** 当前无人机段的配置（供渲染层与排障读取） */
export function droneStyleConfig(): MarkerStyleConfig | undefined {
  return current?.drone
}

/** 当前轨迹段的配置 */
export function trackStyleConfig(): TrackStyleConfig | undefined {
  return current?.track
}
