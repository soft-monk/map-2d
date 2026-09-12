// map-2d · 绘制 API —— 「渲染 + API 驱动」的核心
//
// 用途：宿主不关心 MapLibre 的 source/layer 细节，只用本 API 增删改查图元：
//   MapDraw.set('area', [...]) / add('drone', {...}) / remove('target', 'T-1') / clear('link')
// 数据与样式解耦：图元自带 color/label 等属性；未给则用本文件的内置调色板。
//
// 说明：本层只做「数据 → GeoJSON → LayerManager」的转换与集合管理，
// 不涉及鼠标手绘交互（手绘留待后续版本）。
import { mapInstance, layersReady } from '../core/instance'
import { LayerManager } from '../render/LayerManager'
import { filterValid } from '../core/validate'
import { recordRender, recordSubmit, recordWrite, reportPrimitiveError } from '../core/diagnostics'
import { onPrimitiveEvent, type PrimitiveEvent } from '../core/primitiveEvents'
import { annulusToLines, type AnnulusItem } from '../core/annulus'
import { clusterOptions as _clusterCfg, clusterPoints, filterLabels, labelOptions as _labelCfg, setClusterStats as setLastClusterStats } from '../core/clustering'
import { resolveStyle } from '../core/theme'
import type { LinkState, Threat, UavType } from '../core/types'

// ---------------------------------------------------------------- 图元类型
export type PrimitiveKind =
  | 'area' | 'drone' | 'target' | 'link' | 'track' | 'scan' | 'pulse' | 'cluster' | 'label'
  // 需求 M2-DRAW-01 补全：航线、圆形/椭圆区域、目标区域
  | 'route' | 'shape'
  // 需求 M2-DRAW-09 圈层类图元：距离环、方位线、方位圈、九宫格
  | 'annulus'

export interface AreaItem {
  id: string
  /** 是否显示（默认 true）；见 MapDraw.hide/show（M2-DRAW-03） */
  visible?: boolean
  /** 多边形顶点（经纬度，首尾不必闭合） */
  polygon: [number, number][]
  color?: string
  label?: string
  /** 是否为虚线边界（默认 true） */
  dashed?: boolean
  opacity?: number
}

export interface DroneItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  type?: UavType
  color?: string
  label?: string
}

export interface TargetItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  threat?: Threat
  /** red / yellow / gray（缺省按 threat 推导） */
  status?: string
  label?: string
  color?: string
  selected?: boolean
}

export interface LinkItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  from: [number, number]
  to: [number, number]
  state?: LinkState
  color?: string
  label?: string
}

export interface TrackItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  points: [number, number][]
  color?: string
  dashed?: boolean
}

export interface ScanItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  /** 覆盖半径（公里，按当前缩放换算为像素） */
  radiusKm: number
  color?: string
  label?: string
}

export interface PulseItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  color?: string
  radiusKm?: number
}

export interface ClusterItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  name?: string
  color?: string
}

export interface LabelItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  text: string
  color?: string
  /** 字号（px） */
  size?: number
  /** 圆点半径（px），0 表示只画文字 */
  radius?: number
  /** 最低显示缩放（低于该层级不显示，用于标签分级，M2-DRAW-11） */
  minZoom?: number
}

// ---------------------------------------------------------------- 需求 M2-DRAW-01 补全的图元

/** 无人机航线：一条计划/实际航线（折线） */
export interface RouteItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  /** 航线途经点（至少 2 个） */
  points: [number, number][]
  color?: string
  /** 是否虚线（计划航线通常用虚线，默认 false） */
  dashed?: boolean
  /** 名称（不渲染文字，仅数据字段；需要文字请另用 label 图元） */
  name?: string
}

/**
 * 圆形 / 椭圆形区域，以及目标区域（打击区 / 侦察区）。
 *
 * - 圆形：`lng/lat` + `radiusKm`
 * - 椭圆：再加 `radiusKmMinor`（短半轴）
 * - 目标区域：`kind: 'target'`（默认样式为红色实线）；`kind: 'search'` 为搜索区（虚线）
 *
 * 半径按**公里**表达，模块按当前缩放换算成度并生成多边形（与扫描图元同一套地理尺度语义）。
 */
export type { AnnulusItem } from '../core/annulus'

export interface ShapeItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15）；登记后用 mapCommands.setStyleTemplates() */
  style?: string
  lng: number
  lat: number
  /** 主半径（公里） */
  radiusKm: number
  /** 短半轴（公里）；不给即为正圆 */
  radiusKmMinor?: number
  /** 长轴方位角（度，正北为 0，顺时针） */
  rotation?: number
  /** 语义：普通图形 / 目标区域（默认红色实线）/ 搜索区（虚线） */
  kind?: 'plain' | 'target' | 'search'
  color?: string
  opacity?: number
  /** 线宽（px） */
  weight?: number
  /** 是否虚线（不给则按 kind 推导：search 为虚线） */
  dashed?: boolean
  label?: string
}

export interface DrawSnapshot {
  area: AreaItem[]
  drone: DroneItem[]
  target: TargetItem[]
  link: LinkItem[]
  track: TrackItem[]
  scan: ScanItem[]
  pulse: PulseItem[]
  cluster: ClusterItem[]
  label: LabelItem[]
  /** 无人机航线（M2-DRAW-01） */
  route: RouteItem[]
  /** 圆形 / 椭圆形区域、目标区域（M2-DRAW-01） */
  shape: ShapeItem[]
  /** 圈层类图元：距离环/方位线/方位圈/九宫格（M2-DRAW-09） */
  annulus: AnnulusItem[]
}

// ---------------------------------------------------------------- 调色板
const C = {
  area: '#22d3ee',
  drone: { optical: '#22d3ee', radar: '#f59e0b', electronic: '#a855f7', comm: '#22c55e' } as Record<string, string>,
  threat: { high: '#ef4444', mid: '#f59e0b', low: '#22d3ee' } as Record<string, string>,
  status: { red: '#ef4444', yellow: '#f59e0b', gray: '#8b93a7' } as Record<string, string>,
  link: { green: '#22c55e', yellow: '#f59e0b', red: '#ef4444' } as Record<string, string>,
  track: '#ef4444',
  scan: '#38bdf8',
  pulse: '#22d3ee',
  cluster: '#8b5cf6',
  label: '#cfe3f5',
  route: '#22d3ee',
  shape: '#3b82f6',
  annulus: '#38bdf8',
  target: '#ef4444',
  search: '#f59e0b',
}

// ---------------------------------------------------------------- 内部集合
type AnyItem =
  | AreaItem | DroneItem | TargetItem | LinkItem | TrackItem | ScanItem | PulseItem | ClusterItem | LabelItem
  | RouteItem | ShapeItem | AnnulusItem

const bags: Record<PrimitiveKind, Map<string, AnyItem>> = {
  area: new Map(), drone: new Map(), target: new Map(), link: new Map(),
  track: new Map(), scan: new Map(), pulse: new Map(), cluster: new Map(), label: new Map(),
  route: new Map(), shape: new Map(), annulus: new Map(),
}

/** 公里 → 像素（Web Mercator，按当前缩放） */
function kmToPixels(km: number, lat: number): number {  const zoom = mapInstance.current?.getZoom() ?? 11
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
  return Math.max(2, (km * 1000) / metersPerPixel)
}

const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features })

const point = (lng: number, lat: number, properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lng, lat] },
})

const line = (coords: [number, number][], properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords },
})

const polygon = (ring: [number, number][], properties: Record<string, unknown>): GeoJSON.Feature => {
  const closed = ring.length > 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
    ? [...ring, ring[0]]
    : ring
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [closed] } }
}

/**
 * 圆 / 椭圆 → 多边形环（需求 M2-DRAW-01）。
 * 半径用公里表达（地理尺度，与扫描图元一致），按纬度换算成经度/纬度方向的度数：
 *   纬度 1° ≈ 110.574 km（近似恒定）；经度 1° ≈ 111.320 × cos(lat) km。
 * 椭圆用 `radiusKmMinor`（短半轴）+ `rotation`（长轴方位角，正北为 0，顺时针）表达。
 */
function ellipseRing(s: ShapeItem, segments = 72): [number, number][] {
  const R = 6371.0088 // 地球平均半径 km
  const rad = (d: number) => (d * Math.PI) / 180
  const deg = (r: number) => (r * 180) / Math.PI

  const a = s.radiusKm // 长半轴（km）
  const b = s.radiusKmMinor ?? s.radiusKm // 短半轴（km）
  const rot = rad(s.rotation ?? 0)
  const latRad = rad(s.lat)
  const cosLat = Math.max(1e-6, Math.cos(latRad))

  const ring: [number, number][] = []
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2
    // 以中心为原点的局部平面坐标（东 x，北 y）
    const x = a * Math.cos(t)
    const y = b * Math.sin(t)
    // 按方位角旋转（正北 0、顺时针：北向分量 = x·sin + y·cos）
    const east = x * Math.cos(rot) + y * Math.sin(rot)
    const north = -x * Math.sin(rot) + y * Math.cos(rot)
    const dLat = deg(north / R)
    const dLng = deg(east / (R * cosLat))
    ring.push([s.lng + dLng, s.lat + dLat])
  }
  return ring
}

// ---------------------------------------------------------------- 渲染
// 单个图元显隐（M2-DRAW-03）：visible === false 的项**不画**，但数据仍在集合里
// （list() 读得到、export() 包含），重新显示无需重新灌数据。
function renderKind(kind: PrimitiveKind) {
  if (!layersAvailable()) return   // 图层未建立：先攒着，MapView 就绪后 renderAll 统一补画
  let items = [...bags[kind].values()].filter((it) => (it as { visible?: boolean }).visible !== false)

  // 命名样式模板（M2-DRAW-15）：模板值打底、图元自身字段覆盖。
  // 在这里统一解析，意味着"改模板后调一次 render() 即可让所有引用者一起变"。
  if (items.some((it) => (it as { style?: string }).style)) {
    items = items.map((it) => resolveStyle(it as unknown as Record<string, unknown>) as unknown as AnyItem)
  }

  // 标签分级与避让（M2-DRAW-11）：按当前缩放决定哪些标签该出现
  if (kind === 'label' && items.length) {
    const zoom = mapInstance.current?.getZoom() ?? 0
    const { shown } = filterLabels(items as unknown as { minZoom?: number }[], zoom)
    items = shown as unknown as AnyItem[]
  }

  // 目标聚合（M2-DRAW-10）：按屏幕像素聚类，多点簇转成计数气泡
  if (kind === 'target' && items.length) {
    const map = mapInstance.current
    const zoom = map?.getZoom() ?? 0
    const cfg = _clusterCfg
    if (cfg.enabled && cfg.kinds.includes('target') && zoom <= cfg.maxZoom && map) {
      const { singles, bubbles } = clusterPoints(
        items as unknown as { lng: number; lat: number }[],
        (lng, lat) => map.project([lng, lat]),
        zoom,
      )
      items = singles as unknown as AnyItem[]
      // 气泡写入 cluster 类（计数气泡复用集群渲染）
      const bubbleItems = bubbles.map((b, i) => ({
        id: `cluster-${b.count}-${i}-${Math.round(b.lng * 1e4)}`,
        lng: b.lng, lat: b.lat, name: String(b.count),
      }))
      bubblesRef = bubbleItems
    } else {
      // 未启用 / 超出 maxZoom / 地图未就绪：清掉气泡，并把统计标成"未聚合"
      // （否则统计会停留在上一次的 active:true，看起来像"放大了还在聚合"）
      bubblesRef = []
      setLastClusterStats({ input: items.length, output: items.length, active: false })
    }
  } else if (kind === 'target') {
    bubblesRef = []
    setLastClusterStats({ input: 0, output: 0, active: false })
  }

  const t0 = performance.now()
  try {
    renderItems(kind, items)
  } catch (err) {
    // 错误边界（M2-NFR-10）：渲染层异常不向上抛，转为可查询的错误记录
    reportPrimitiveError({ kind, id: '(整类)', reason: String((err as Error)?.message ?? err) })
  } finally {
    recordSubmit(performance.now() - t0)
  }
}

function renderItems(kind: PrimitiveKind, items: AnyItem[]) {
  recordRender()                      // 真正落到数据源的渲染次数（M2-NFR-14 口径）
  switch (kind) {
    case 'area':
      LayerManager.setAreaFeatures(fc((items as AreaItem[]).map((a) =>
        polygon(a.polygon, { id: a.id, color: a.color ?? C.area, label: a.label ?? '', opacity: a.opacity ?? 0.1 }))))
      break
    case 'drone':
      LayerManager.setUavFeatures(fc((items as DroneItem[]).map((d) =>
        point(d.lng, d.lat, { id: d.id, label: d.label ?? d.id, color: d.color ?? C.drone[d.type ?? ''] ?? C.area }))))
      break
    case 'target':
      // 聚合气泡（M2-DRAW-10）与目标点共用一次渲染：气泡走 cluster 源
      LayerManager.setGroupFeatures(fc(bubblesRef.map((b) =>
        point(b.lng, b.lat, { id: b.id, name: b.name, color: '#8b5cf6' }))))
      LayerManager.setTargetFeatures(fc((items as TargetItem[]).map((t) => point(t.lng, t.lat, {
        id: t.id,
        label: t.label ?? t.id,
        color: t.color ?? C.status[t.status ?? ''] ?? C.threat[t.threat ?? ''] ?? C.area,
        selected: !!t.selected,
        threat: t.threat ?? 'mid',
      }))))
      break
    case 'link':
      LayerManager.setLinkFeatures(fc((items as LinkItem[]).map((l) =>
        line([l.from, l.to], { id: l.id, color: l.color ?? C.link[l.state ?? ''] ?? C.link.green, state: l.state ?? 'green', name: l.label ?? l.id }))))
      break
    case 'track':
      LayerManager.setTrackFeatures(fc((items as TrackItem[]).map((t) =>
        line(t.points, { id: t.id, color: t.color ?? C.track, dashed: t.dashed ?? true }))))
      break
    case 'scan':
      LayerManager.setScanFeatures(fc((items as ScanItem[]).map((s) =>
        point(s.lng, s.lat, {
          id: s.id,
          color: s.color ?? C.scan,
          r: kmToPixels(s.radiusKm, s.lat),
          label: s.label ?? '',
        }))))
      break
    case 'pulse':
      LayerManager.setPulseSeedsPublic((items as PulseItem[]).map((p) => ({
        id: p.id, lng: p.lng, lat: p.lat, color: p.color ?? C.pulse,
      })))
      break
    case 'cluster':
      LayerManager.setGroupFeatures(fc((items as ClusterItem[]).map((c) =>
        point(c.lng, c.lat, { id: c.id, name: c.name ?? c.id, color: c.color ?? C.cluster }))))
      break
    case 'label':
      LayerManager.setMarkers(fc((items as LabelItem[]).map((m) =>
        point(m.lng, m.lat, { id: m.id, text: m.text, color: m.color ?? C.label, size: m.size ?? 11, r: m.radius ?? 0 }))))
      break
    case 'route':
      LayerManager.setRouteFeatures(fc((items as RouteItem[]).map((r) =>
        line(r.points, { id: r.id, color: r.color ?? C.route, dashed: r.dashed ?? false, name: r.name ?? r.id }))))
      break
    case 'annulus':
      LayerManager.setAnnulusFeatures(fc((items as AnnulusItem[]).flatMap((a) =>
        annulusToLines(a).map((pts, i) => line(pts, {
          id: a.id, part: i, color: a.color ?? C.annulus,
          weight: a.weight ?? 1.2, dashed: a.dashed ?? false,
        })))))
      break
    case 'shape':
      LayerManager.setShapeFeatures(fc((items as ShapeItem[]).map((s) => {
        const color = s.color ?? (s.kind === 'target' ? C.target : s.kind === 'search' ? C.search : C.shape)
        return polygon(ellipseRing(s), {
          id: s.id,
          color,
          opacity: s.opacity ?? 0.12,
          weight: s.weight ?? (s.kind === 'plain' ? 1.4 : 1.8),
          dashed: s.dashed ?? (s.kind === 'search'),
          label: s.label ?? '',
        })
      })))
      break
  }
}

function renderAll() {
  ;(Object.keys(bags) as PrimitiveKind[]).forEach(renderKind)
}

// 缩放变化后，扫描半径需要按新的缩放重算
let zoomHooked = false
function ensureZoomHook() {
  if (zoomHooked) return
  const map = mapInstance.current
  if (!map) return
  map.on('zoomend', () => {
    // 缩放变化会影响三类渲染：
    //   scan   —— 半径按缩放换算成像素
    //   target —— 聚合结果随缩放变化（M2-DRAW-10）
    //   label  —— 标签分级随缩放显现/隐藏（M2-DRAW-11）
    if (bags.scan.size > 0) renderKind('scan')
    // 目标：只要启用过聚合就要重画——放大越过 maxZoom 时必须把气泡清掉（否则残留）
    if (bags.target.size > 0) renderKind('target')
    // 标签：分级由每个图元的 minZoom 决定，与"是否启用策略"无关，所以无条件重画
    if (bags.label.size > 0) renderKind('label')
  })
  zoomHooked = true
}

/** 上一轮聚合得到的气泡（渲染 target 时一并写入 cluster 源） */
let bubblesRef: { id: string; lng: number; lat: number; name: string }[] = []

// ---------------------------------------------------------------- 批量提交（M2-API-07 / M2-NFR-14）
// 批次内只改集合、不渲染；退出时对"受影响的类型"各提交一次（单帧渲染）。
let batchDepth = 0
const dirty = new Set<PrimitiveKind>()

function markDirty(kind: PrimitiveKind) {
  recordWrite()                       // 写入次数（不等价于渲染次数）
  if (batchDepth > 0) dirty.add(kind) // 批内只攒着，退出批次时合并成一次渲染
  else renderKind(kind)
}

/**
 * 图层是否已建立。未建立时数据仍会进入集合（list/export 正确），
 * 但不会去写不存在的源——等 `MapView` 在 load 后调用 `renderAll()` 一次性补齐。
 * 这样"建图前就灌数据"不会静默丢失（曾经的坑：演示宿主 isReady 判据不对导致图元不显示）。
 */
function layersAvailable(): boolean {
  return layersReady.current && !!mapInstance.current
}

function flushDirty(): PrimitiveKind[] {
  const kinds = [...dirty]
  dirty.clear()
  for (const k of kinds) renderKind(k)
  return kinds
}

// ---------------------------------------------------------------- 公开 API
export const MapDraw = {
  /** 整组替换某类图元；非法项跳过并上报（M2-NFR-10），合法项照常渲染 */
  set<K extends PrimitiveKind>(kind: K, items: DrawSnapshot[K]) {
    bags[kind].clear()
    const { valid } = filterValid(kind, items as { id?: unknown }[])
    ;(valid as AnyItem[]).forEach((it) => bags[kind].set(it.id, it))
    ensureZoomHook()
    markDirty(kind)
  },

  /** 新增或更新单个图元；数据非法时跳过并上报，返回是否被接受 */
  add<K extends PrimitiveKind>(kind: K, item: DrawSnapshot[K][number]) {
    const { valid } = filterValid(kind, [item as { id?: unknown }])
    if (!valid.length) return false
    const it = valid[0] as AnyItem
    bags[kind].set(it.id, it)
    ensureZoomHook()
    markDirty(kind)
    return true
  },

  /** 删除单个图元 */
  remove(kind: PrimitiveKind, id: string) {
    if (bags[kind].delete(id)) markDirty(kind)
  },

  /** 清空某类（不传 kind 则清空全部图元并清掉地图上所有动态图层） */
  clear(kind?: PrimitiveKind) {
    if (!kind) {
      ;(Object.keys(bags) as PrimitiveKind[]).forEach((k) => bags[k].clear())
      dirty.clear()
      LayerManager.clearAll()
      return
    }
    bags[kind].clear()
    markDirty(kind)
  },

  /**
   * 批量提交（M2-API-07）：批次内可以任意次 set/add/remove，退出时按受影响类型各渲染一次。
   * 返回本次受影响的类型清单，便于宿主确认。
   */
  batch<T>(fn: () => T): { result: T; kinds: PrimitiveKind[] } {
    batchDepth++
    let result!: T
    try {
      result = fn()
    } finally {
      batchDepth = Math.max(0, batchDepth - 1)
    }
    const kinds = batchDepth === 0 ? flushDirty() : []
    return { result, kinds }
  },

  // -------------------------------------------------------------- 事件订阅（M2-DRAW-13）
  /**
   * 订阅图元交互事件。等价于 `onPrimitiveEvent`，放在这里是为了"绘制 API 上就能订阅"的心智一致。
   * `click` 只在点到图元时触发；`hover` 同一图元不重复触发。
   */
  on(name: 'click' | 'hover', fn: (e: PrimitiveEvent) => void): () => void {
    return onPrimitiveEvent(name, fn)
  },

  // -------------------------------------------------------------- 单个图元显隐（M2-DRAW-03）
  /** 隐藏某类里的一个图元（数据保留） */
  hide(kind: PrimitiveKind, id: string) {
    this.setVisible(kind, id, false)
  },

  /** 重新显示某类里的一个图元 */
  show(kind: PrimitiveKind, id: string) {
    this.setVisible(kind, id, true)
  },

  /** 设置单个图元的显示状态；图元不存在时返回 false */
  setVisible(kind: PrimitiveKind, id: string, visible: boolean): boolean {
    const item = bags[kind].get(id) as { visible?: boolean } | undefined
    if (!item) return false
    item.visible = visible
    markDirty(kind)
    return true
  },

  /** 隐藏某一类的全部图元（不传则隐藏所有类型） */
  hideAll(kind?: PrimitiveKind) {
    const kinds = kind ? [kind] : (Object.keys(bags) as PrimitiveKind[])
    for (const k of kinds) {
      bags[k].forEach((it) => { (it as { visible?: boolean }).visible = false })
      markDirty(k)
    }
  },

  /** 恢复显示（不传 kind 则显示所有类型） */
  showAll(kind?: PrimitiveKind) {
    const kinds = kind ? [kind] : (Object.keys(bags) as PrimitiveKind[])
    for (const k of kinds) {
      bags[k].forEach((it) => { (it as { visible?: boolean }).visible = true })
      markDirty(k)
    }
  },

  /** 查询单个图元是否显示（图元不存在返回 false） */
  isVisible(kind: PrimitiveKind, id: string): boolean {
    const item = bags[kind].get(id) as { visible?: boolean } | undefined
    return !!item && item.visible !== false
  },

  /** 读取某类图元（副本） */
  list<K extends PrimitiveKind>(kind: K): DrawSnapshot[K] {
    return [...bags[kind].values()] as DrawSnapshot[K]
  },

  /** 导出全部图元（可 JSON 序列化，便于存档/交付） */
  export(): DrawSnapshot {
    return {
      area: this.list('area'), drone: this.list('drone'), target: this.list('target'),
      link: this.list('link'), track: this.list('track'), scan: this.list('scan'),
      pulse: this.list('pulse'), cluster: this.list('cluster'), label: this.list('label'),
      route: this.list('route'), shape: this.list('shape'), annulus: this.list('annulus'),
    }
  },

  /** 导入一份图元快照（整体覆盖） */
  load(snapshot: Partial<DrawSnapshot>) {
    ;(Object.keys(bags) as PrimitiveKind[]).forEach((k) => {
      const items = snapshot[k as keyof DrawSnapshot]
      if (items) MapDraw.set(k, items as never)
    })
  },

  /** 手动重绘（例如地图刚初始化完成、或缩放后需要重算像素半径） */
  render() {
    ensureZoomHook()
    renderAll()
  },
}
