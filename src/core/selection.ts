// map-2d · 图元选中与删除（★ 2026-09-18，需求方："点击选中状态，按键盘 delete，提示删除，确认删除"）
//
// 分工（模块不做弹窗，弹窗是宿主的事）：
//   · 模块：**谁被选中**（状态）+ **高亮画出来** + **监听 Delete 键** + **删掉它**
//   · 宿主：听到"用户按了 Delete"后**弹确认框**，用户确认再调 `deleteSelection()`
//     —— 模块只提供一个回调口 `onDeleteRequest`，不假设宿主用什么 UI。
//
// 为什么高亮不用 `feature-state`：那要给 13 种图层的 paint 各加一条 `case`（13 处改动）；
// 这里改成**一条独立的高亮源 + 三层**（面填充 / 线 / 点圆环），一处实现通吃所有种类。
import { MapDraw, type PrimitiveKind } from '../primitives/api'
import { draw } from '../primitives/draw-api'
import { LayerManager } from '../render/LayerManager'
import { mapInstance } from '../core/instance'

/** 当前选中的图元（null = 没选中） */
let selected: { kind: PrimitiveKind; id: string } | null = null
/** 宿主注册的"用户按了 Delete"回调；没注册时模块**不删任何东西**（避免误删） */
let deleteRequest: ((sel: { kind: PrimitiveKind; id: string }) => void) | null = null
let keyBound = false

/** 读当前选中（没选中返回 null） */
export function currentSelection(): { kind: PrimitiveKind; id: string } | null {
  return selected ? { ...selected } : null
}

/** 宿主注册回调：用户在选中状态下按了 Delete/Backspace（**确认由宿主做**） */
export function onDeleteRequest(fn: ((sel: { kind: PrimitiveKind; id: string }) => void) | null): void {
  deleteRequest = fn
}

/** 宿主注册回调：选中态变了（含"点空白处取消选中"）——宿主用它收起确认条一类的浮层 */
let selectionListeners: ((sel: { kind: PrimitiveKind; id: string } | null) => void)[] = []

/** 订阅选中态变化；返回取消订阅的函数 */
export function onSelectionChange(fn: (sel: { kind: PrimitiveKind; id: string } | null) => void): () => void {
  selectionListeners.push(fn)
  return () => { selectionListeners = selectionListeners.filter((f) => f !== fn) }
}

/** 通知订阅者（选中/取消都会走这里） */
function emitSelection(): void {
  const cur = currentSelection()
  for (const fn of selectionListeners) {
    try { fn(cur) } catch { /* 订阅者自己的异常不影响模块 */ }
  }
}

/** 按 id 找图元在哪个种类里（跨 13 类查一次） */
function findKind(id: string): PrimitiveKind | null {
  const kinds: PrimitiveKind[] = ['area', 'shape', 'route', 'track', 'link', 'scan', 'cluster', 'annulus', 'symbol', 'target', 'pulse', 'drone', 'label']
  for (const k of kinds) {
    if ((MapDraw.list(k) as unknown as { id?: string }[]).some((x) => x?.id === id)) return k
  }
  return null
}

/** 取图元做高亮要用的几何（点 → 圆环；线 → 折线；面 → 环；圆/椭圆 → 环绕一圈） */
function highlightOf(kind: PrimitiveKind, item: Record<string, unknown>): GeoJSON.Feature[] {
  const ring = (pts: [number, number][]): GeoJSON.Feature => ({
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: [...pts, pts[0]] },
  })
  const dot = (lng: number, lat: number, rKm: number): GeoJSON.Feature => ({
    type: 'Feature', properties: {},
    geometry: { type: 'Point', coordinates: [lng, lat], ...(rKm ? { } : {}) } as never,
  })
  const lng = item.lng as number | undefined
  const lat = item.lat as number | undefined
  if (typeof lng === 'number' && typeof lat === 'number') return [dot(lng, lat, 0)]
  const poly = item.polygon as [number, number][] | undefined
  if (Array.isArray(poly) && poly.length >= 3) return [ring(poly)]
  const pts = item.points as [number, number][] | undefined
  if (Array.isArray(pts) && pts.length >= 2) return [ring(pts)]
  const from = item.from as [number, number] | undefined
  const to = item.to as [number, number] | undefined
  if (from && to) return [ring([from, to])]
  // 圆 / 椭圆：按半径绕一圈（36 段），外扩 2% 免得压在图形上
  const rKm = item.radiusKm as number | undefined
  if (typeof rKm === 'number' && rKm > 0) {
    const minor = (item.radiusKmMinor as number | undefined) ?? rKm
    const rot = (((item.rotation as number | undefined) ?? 0) * Math.PI) / 180
    const out: [number, number][] = []
    for (let i = 0; i <= 36; i++) {
      const t = (i / 36) * Math.PI * 2
      const x = rKm * 1.02 * Math.cos(t)
      const y = minor * 1.02 * Math.sin(t)
      const east = x * Math.cos(rot) + y * Math.sin(rot)
      const north = -x * Math.sin(rot) + y * Math.cos(rot)
      out.push([lng! + east / (111.32 * Math.cos((lat! * Math.PI) / 180)), lat! + north / 110.54])
    }
    return [ring(out)]
  }
  void kind
  return []
}

/** 把选中态画出来（高亮源 + 图层在 LayerManager 里建，这里只喂几何） */
function paintHighlight(): void {
  if (!selected) { LayerManager.setSelectionFeatures({ type: 'FeatureCollection', features: [] } as never); return }
  const items = MapDraw.list(selected.kind) as unknown as Record<string, unknown>[]
  const item = items.find((x) => x?.id === selected!.id)
  const feats = item ? highlightOf(selected.kind, item) : []
  LayerManager.setSelectionFeatures({ type: 'FeatureCollection', features: feats } as never)
}

/** 选中一个图元（并高亮）；传 null 等于取消选中 */
export function select(kind: PrimitiveKind | null, id: string | null): void {
  const before = selected ? `${selected.kind}:${selected.id}` : ''
  selected = kind && id ? { kind, id } : null
  const after = selected ? `${selected.kind}:${selected.id}` : ''
  paintHighlight()
  if (before !== after) emitSelection()
}

/** 取消选中 */
export function clearSelection(): void {
  select(null, null)
}

/**
 * **删除当前选中的图元**（宿主在用户确认后调用）。
 * 几何原语走 `draw.remove`（**顺带解绑它的文本**），其余种类走 `MapDraw.remove`。
 * @returns 被删掉的图元（没选中/找不到返回 null）
 */
export function deleteSelection(): { kind: PrimitiveKind; id: string } | null {
  const sel = selected
  if (!sel) return null
  const kind = findKind(sel.id) ?? sel.kind
  const removed = draw.remove(sel.id) || false
  if (!removed) MapDraw.remove(kind, sel.id)
  clearSelection()
  return { kind, id: sel.id }
}

/** 挂上"点击选中 + 点空白取消 + Delete 键"（`MapView` 在图层就绪后调一次；幂等） */
export function bindSelection(): void {
  /** 本次点击是否命中了图元（由下面的 `MapDraw.on('click')` 置位） */
  let hitThisClick = false
  MapDraw.on('click', (e) => {
    // 点空白处不会被触发（模块只在命中图元时回调）；点同一个 = 保持选中
    hitThisClick = true
    select(e.kind, e.id)
  })
  const map = mapInstance.current
  if (map) {
    // ★ 2026-09-18（需求方："选中后，点击地图空白处、没有绘制图元处，取消选中状态"）：
    //   这条要听**原始的地图点击**（`MapDraw.on('click')` 只在命中图元时才发）。
    //   用 `queueMicrotask` 等同一轮所有 click 处理器跑完再判断"这一下到底有没有命中"——
    //   这样**不依赖注册顺序**（模块内 `bindPrimitiveEvents` 与本函数的先后不保证）。
    map.on('click', () => {
      queueMicrotask(() => {
        if (!hitThisClick) clearSelection()
        hitThisClick = false
      })
    })
  }
  if (keyBound || typeof window === 'undefined') return
  keyBound = true
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const sel = selected
    if (!sel) return
    // 正在输入框里打字时不要触发删除（不然改文本按退格就把图元删了）
    const el = e.target as HTMLElement | null
    const tag = el?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
    e.preventDefault()
    // **确认由宿主做**：只把"用户想删"这件事报出去
    if (deleteRequest) deleteRequest({ ...sel })
  })
}

/** 地图实例是否就绪（宿主可用它决定要不要提示"地图未就绪"） */
export function selectionReady(): boolean {
  return !!mapInstance.current
}
