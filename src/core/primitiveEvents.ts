// map-2d · 图元事件（需求 M2-DRAW-13）
//
// 语义：宿主可以订阅"点了哪个图元 / 悬停了哪个图元"，回调只带**图元身份**，
// 空白处点击不触发。模块内部通过 MapLibre 的 queryRenderedFeatures 反查图元 id，
// 因此宿主完全不需要知道图层名。
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

function pick(e: MapLayerMouseEvent, map: MlMap): PrimitiveEvent | null {
  const layers = probeLayers(map)
  if (!layers.length) return null
  const feats = map.queryRenderedFeatures(e.point, { layers })
  if (!feats.length) return null
  // 同一图元可能命中多个图层（光晕/标签），按 kind+id 去重后取第一个
  for (const f of feats) {
    const kind = f.layer?.id ? LAYER_KIND.get(f.layer.id) : undefined
    const props = (f.properties ?? {}) as Record<string, unknown>
    const id = typeof props.id === 'string' && props.id ? props.id : undefined
    if (kind && id) {
      return { kind, id, lngLat: [e.lngLat.lng, e.lngLat.lat], properties: props }
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
