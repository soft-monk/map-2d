// map-2d · 图元事件（需求 M2-DRAW-13）
//
// 语义：宿主可以订阅"点了哪个图元 / 悬停了哪个图元"，回调只带**图元身份**，
// 空白处点击不触发。模块内部通过 MapLibre 的 queryRenderedFeatures 反查图元 id，
// 因此宿主完全不需要知道图层名。
import { Point } from 'maplibre-gl'
import type { Map as MlMap, MapLayerMouseEvent } from 'maplibre-gl'
import { mapInstance } from './instance'
import type { PrimitiveKind } from '../primitives/api'

export type PrimitiveEventName = 'click' | 'hover'

export interface PrimitiveEvent {
  kind: PrimitiveKind
  id: string
  lngLat: [number, number]
  /** 原始要素属性（高级用法，例如取 state/threat） */
  properties: Record<string, unknown>
}

type Handler = (e: PrimitiveEvent) => void

/**
 * 命中检测入参：真实鼠标事件（`MapLayerMouseEvent`）或屏幕坐标。
 * ⚠️ 坑：`map.queryRenderedFeatures(point)` 只认 MapLibre 的 `Point` 实例（带 x/y 的对象字面量
 * 会被当成"无 point"，退化成**整屏查询**，于是永远命中第一个要素）。因此这里统一转成 Point 实例。
 */
export type PickInput = MapLayerMouseEvent | { x: number; y: number } | [number, number]

/** 图元类型 → 参与命中检测的图层 id（与 render/LayerManager 的 LYR 常量对应） */
const KIND_LAYERS: Record<PrimitiveKind, string[]> = {
  area: ['lyr-area-fill', 'lyr-area-line'],
  link: ['lyr-link', 'lyr-link-glow'],
  cluster: ['lyr-group', 'lyr-group-label'],
  target: ['lyr-target', 'lyr-target-glow', 'lyr-target-label'],
  drone: ['lyr-uav', 'lyr-uav-glow', 'lyr-uav-label'],
  scan: ['lyr-scan'],
  track: ['lyr-track'],
  pulse: ['lyr-pulse'],
  label: ['lyr-mark', 'lyr-mark-label'],
  route: ['lyr-route', 'lyr-route-dashed', 'lyr-route-glow'],
  shape: ['lyr-shape-fill', 'lyr-shape-line', 'lyr-shape-line-dashed'],
  annulus: ['lyr-annulus', 'lyr-annulus-dashed'],
}

const handlers: Record<PrimitiveEventName, Set<Handler>> = {
  click: new Set(),
  hover: new Set(),
}

/** 命中检测的图层列表（只查当前地图上真的存在的图层） */
function probeLayers(map: MlMap): string[] {
  const out: string[] = []
  for (const ids of Object.values(KIND_LAYERS)) {
    for (const id of ids) if (map.getLayer(id)) out.push(id)
  }
  return out
}

const LAYER_KIND = new Map<string, PrimitiveKind>()
for (const [kind, ids] of Object.entries(KIND_LAYERS) as [PrimitiveKind, string[]][]) {
  for (const id of ids) LAYER_KIND.set(id, kind)
}

/** 把三种入参统一成 { x, y } 屏幕坐标（MapLibre 的 Point 行为由下面的 pick 保证） */
function toXY(input: PickInput): { x: number; y: number } {
  if (Array.isArray(input)) return { x: input[0], y: input[1] }
  if ('point' in input && input.point) {
    const p = input.point as { x: number; y: number }
    return { x: p.x, y: p.y }
  }
  return input as { x: number; y: number }
}

function pick(input: PickInput, map: MlMap): PrimitiveEvent | null {
  const layers = probeLayers(map)
  if (!layers.length) return null

  const { x, y } = toXY(input)
  // ⚠️ 必须构造 Point 实例：传对象字面量会让 queryRenderedFeatures 退化成整屏查询
  const point = new Point(x, y)
  const feats = map.queryRenderedFeatures(point, { layers })
  if (!feats.length) return null

  const lngLat: [number, number] =
    'lngLat' in input && input.lngLat
      ? [input.lngLat.lng, input.lngLat.lat]
      : (() => { const ll = map.unproject(point); return [ll.lng, ll.lat] })()

  // 同一图元可能命中多个图层（光晕/标签/实虚线两套），按 kind+id 去重后取第一个
  for (const f of feats) {
    const kind = f.layer?.id ? LAYER_KIND.get(f.layer.id) : undefined
    const props = (f.properties ?? {}) as Record<string, unknown>
    const id = typeof props.id === 'string' && props.id ? props.id : undefined
    if (kind && id) {
      return { kind, id, lngLat, properties: props }
    }
  }
  return null
}

let bound = false
let lastHoverKey = ''

/** 把事件桥接到地图上（幂等；MapView 初始化完成后调用即可） */
export function bindPrimitiveEvents(map: MlMap = mapInstance.current as MlMap): void {
  if (bound || !map) return
  bound = true

  map.on('click', (e) => {
    if (!handlers.click.size) return
    const hit = pick(e as MapLayerMouseEvent, map)
    if (!hit) return
    for (const fn of [...handlers.click]) {
      try { fn(hit) } catch { /* 单个回调异常不影响其他 */ }
    }
  })

  map.on('mousemove', (e) => {
    if (!handlers.hover.size) return
    const hit = pick(e as MapLayerMouseEvent, map)
    const key = hit ? `${hit.kind}:${hit.id}` : ''
    if (key === lastHoverKey) return          // 同一图元不重复回调
    lastHoverKey = key
    if (!hit) return
    for (const fn of [...handlers.hover]) {
      try { fn(hit) } catch { /* 同上 */ }
    }
  })
}

/** 取消桥接（测试/卸载用） */
export function unbindPrimitiveEvents(): void {
  bound = false
  lastHoverKey = ''
}

/** 订阅图元事件；返回取消订阅函数 */
export function onPrimitiveEvent(name: PrimitiveEventName, fn: Handler): () => void {
  handlers[name].add(fn)
  return () => { handlers[name].delete(fn) }
}

/** 清空全部订阅（测试/重置用） */
export function clearPrimitiveHandlers(): void {
  handlers.click.clear()
  handlers.hover.clear()
}

/**
 * 按屏幕坐标做一次命中检测（与事件路径同一套逻辑）。
 * 导出用于：宿主自绘控件做"鼠标下有哪个图元"的判断，以及排查命中问题。
 */
export function pickAt(x: number, y: number, map: MlMap = mapInstance.current as MlMap): PrimitiveEvent | null {
  if (!map) return null
  return pick({ x, y }, map)
}

/** 当前订阅数（排查用） */
export function primitiveHandlerCounts(): { click: number; hover: number; bound: boolean } {
  return { click: handlers.click.size, hover: handlers.hover.size, bound }
}
