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
import { applyDegrade } from '../core/degrade'
import { renderSymbols } from '../core/symbols'
import {
  DEFAULT_POINT_RADIUS_PX, DEFAULT_POINT_STROKE_COLOR, DEFAULT_POINT_STROKE_WIDTH_PX,
  DEFAULT_TRACK_OPACITY, DEFAULT_TRACK_WIDTH_PX, DEFAULT_ICON_SIZE_PX,
  ensureMarkerImages, iconFailureCount, iconImageName, iconLoadCount,
  resolveMarkerPlan, setStyleConfig, styleConfig,
  type MapStyleConfig, type MarkerRenderPlan,
} from '../core/markerIcon'
import type { LinkState, Threat, UavType } from '../core/types'

// ---------------------------------------------------------------- 图元类型
export type PrimitiveKind =
  | 'area' | 'drone' | 'target' | 'link' | 'track' | 'scan' | 'pulse' | 'cluster' | 'label'
  // 需求 M2-DRAW-01 补全：航线、圆形/椭圆区域、目标区域
  | 'route' | 'shape'
  // 需求 M2-DRAW-09 圈层类图元：距离环、方位线、方位圈、九宫格
  | 'annulus'
  // 需求 M2-DRAW-16 国军标标绘符号
  | 'symbol'

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
  /**
   * 画点半径（px）。**可选**：不给则按「样式配置 `drone.point.radiusPx` > 5」取值。
   * 只在"回落画点"时生效（画位图时由 `icon.sizePx` 决定大小）。
   */
  radiusPx?: number
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
  /**
   * 线宽（px）。**可选**：不给则按「样式配置 `track.widthPx` > 2」取值
   * —— 2 是模块改造前的固定线宽，因此不传本字段时画面与今天一致。
   */
  widthPx?: number
  /** 线透明度；不给则按「样式配置 `track.opacity` > 0.9」取值（0.9 为改造前的取值） */
  opacity?: number
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
  /** 国军标标绘符号（M2-DRAW-16） */
  symbol: SymbolItem[]
}

/**
 * 国军标标绘符号图元（M2-DRAW-16）。
 * 符号图形由模块内置（12 个常用兵种）+ 宿主可扩展；框形与颜色随敌我属性变化。
 */
export interface SymbolItem {
  id: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 命名样式模板名（M2-DRAW-15） */
  style?: string
  lng: number
  lat: number
  /** 符号 key（内置见 SYMBOLS；也可用 registerSymbol 注册自定义） */
  symbol: string
  /** 敌我属性（决定框形与颜色） */
  affiliation?: 'friend' | 'hostile' | 'neutral' | 'unknown'
  /** 旋转角度（度，正北为 0、顺时针） */
  rotation?: number
  /** 缩放（默认 1；0.5–4 之间比较合理） */
  size?: number
  /** 标注（画在符号下方） */
  label?: string
  color?: string
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
  | RouteItem | ShapeItem | AnnulusItem | SymbolItem

const bags: Record<PrimitiveKind, Map<string, AnyItem>> = {
  area: new Map(), drone: new Map(), target: new Map(), link: new Map(),
  track: new Map(), scan: new Map(), pulse: new Map(), cluster: new Map(), label: new Map(),
  route: new Map(), shape: new Map(), annulus: new Map(), symbol: new Map(),
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

  // 大数据量降级（M2-NFR-13）：超阈值时抽稀/简化几何。只影响"画出来的"，
  // 不改动图元集合——list()/export() 始终是全量。
  items = applyDegrade(kind, items as unknown as Record<string, unknown>[]) as unknown as AnyItem[]

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
  // 国军标符号：先按 items 组装要素（渲染时需要 symbol/affiliation/rotation/size）
  const features = kind === 'symbol'
    ? (items as SymbolItem[]).map((s) => ({ lng: s.lng, lat: s.lat, properties: { id: s.id, symbol: s.symbol, affiliation: s.affiliation ?? 'friend', rotation: s.rotation ?? 0, size: s.size ?? 1, label: s.label ?? '', color: s.color } }))
    : []
  switch (kind) {
    case 'area':
      LayerManager.setAreaFeatures(fc((items as AreaItem[]).map((a) =>
        polygon(a.polygon, { id: a.id, color: a.color ?? C.area, label: a.label ?? '', opacity: a.opacity ?? 0.1 }))))
      break
    case 'drone': {
      // 位图图标 + 缺省画点（本批新增，**纯可选**）：
      //   未登记样式配置时，每个图元都解析成"画点"，且属性就是改造前的固定取值
      //   （半径 5 / 描边 #e8f1ff / 描边宽 1），因此画面与今天逐像素一致。
      //   登记了样式配置时：useIcon 且图标可用 → 位图；否则 → 画点。
      renderDrones(items as DroneItem[])
      break
    }
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
    case 'track': {
      // 轨迹线宽 / 透明度改为数据驱动（本批新增，**纯可选**）：
      //   解析优先级 = 图元字段 > 样式配置 > 内置缺省（2px / 0.9），
      //   缺省即改造前的固定取值，因此不配、不传时画面不变。
      //   `dash` 用数字分流（1 = 虚线、0 = 实线）——line-dasharray 不支持数据表达式。
      const tcfg = styleConfig()?.track
      LayerManager.setTrackFeatures(fc((items as TrackItem[]).map((t) =>
        line(t.points, {
          id: t.id,
          color: t.color ?? tcfg?.color ?? C.track,
          width: t.widthPx ?? tcfg?.widthPx ?? DEFAULT_TRACK_WIDTH_PX,
          lineOpacity: t.opacity ?? tcfg?.opacity ?? DEFAULT_TRACK_OPACITY,
          // 改造前的默认是虚线（lyr-track 的 line-dasharray [3,2]），这里保持不变
          dash: (t.dashed ?? tcfg?.dashed ?? true) ? 1 : 0,
        }))))
      break
    }
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
    case 'symbol':
      renderSymbols(mapInstance.current as never, features.map((f) => ({
        type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
      })))
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

// ---------------------------------------------------------------- 无人机：位图图标 + 缺省画点
//
// 为什么分两步（同步落点 + 异步升级为位图）：
//   位图是**异步**解码的，而 MapLibre 的 `icon-image` 一旦取不到图片就什么都不画。
//   如果先等图片再落数据，快照到达与画面之间会有一段空白；如果只落位图，
//   加载失败时该无人机就彻底消失 —— 两者都不能接受。
//   因此：**先按"画点"落数据**（立刻可见、与改造前完全一致），
//   图片就绪后再把这一批要点重落一次、给命中者打上 `hasIcon`，圆点层自动让位给图标层。
//   图片永远加载不出来的那些，就一直是点 —— 这就是"加载失败降级为点"。

/** 正在等待图片的无人机集合（按地图实例隔离；同一 URL 只等一次） */
let pendingIconKey = ''
let pendingIcons = false

/** 已经失败过的图标 URL：同一张坏图不再无限重试（每次失败仍会被 markerIcon 计数） */
const badIconUrls = new Set<string>()

/**
 * 允许对"此前失败过的图标 URL"重新发起一次加载。
 * 配置变化时自动调用（换配置 = 表达"再试一次"的意图）；
 * 图标服务临时不可用后恢复的宿主也可以手动调 `MapDraw.retryIconLoads()`。
 */
export function retryIconLoads(): void {
  badIconUrls.clear()
}

/** 供排障/自测读取：最近一次快照里"想画位图但回落成点"的图元 id → 原因 */
const degradedIcons = new Map<string, string>()

/** 最近一次无人机渲染的位图/画点统计（自测与宿主排障用） */
let lastDroneRenderMode = { icon: 0, point: 0 }

/**
 * 快照 → 要素。`okImages` 里有的图片名才会被标成位图；其余一律走圆点层。
 * 未登记样式配置时，每个图元都解析成画点，属性就是改造前的固定取值
 * （半径 5 / 描边 #e8f1ff / 描边宽 1）—— 因此不配样式时画面与今天一致。
 */
function droneFeatures(items: DroneItem[], okImages: Set<string>): GeoJSON.Feature[] {
  const cfg = styleConfig()?.drone
  return items.map((d) => {
    const plan: MarkerRenderPlan = resolveMarkerPlan(d, cfg)
    const props: Record<string, unknown> = {
      id: d.id,
      label: d.label ?? d.id,
      // 图元 color > 样式配置 point.color > 内置按机型调色板（保持改造前的优先级）
      color: plan.color ?? C.drone[d.type ?? ''] ?? C.area,
      radius: plan.radiusPx,
      strokeColor: plan.strokeColor,
      strokeWidth: plan.strokeWidthPx,
    }
    if (plan.mode === 'icon' && plan.image && okImages.has(plan.image)) {
      props.hasIcon = true
      props.icon = plan.image
      props.iconSize = iconScale(plan.sizePx)
      props.iconAnchor = plan.anchor
    } else if (plan.mode === 'icon') {
      // 想画位图但图片不可用 —— 记下可读原因，画点兜底
      degradedIcons.set(d.id, plan.fallbackReason ?? `图标不可用：${plan.url ?? '(无 url)'}`)
    }
    return point(d.lng, d.lat, props)
  })
}

/** 快照里所有"想画位图"的 URL（去重，带上各自的设计尺寸） */
function wantedIcons(items: DroneItem[]): { url: string; sizePx?: [number, number] }[] {
  const cfg = styleConfig()?.drone
  const seen = new Map<string, [number, number] | undefined>()
  for (const d of items) {
    const plan = resolveMarkerPlan(d, cfg)
    if (plan.mode !== 'icon' || !plan.url) continue
    if (badIconUrls.has(plan.url)) continue
    if (!seen.has(plan.url)) seen.set(plan.url, plan.sizePx)
  }
  return [...seen.entries()].map(([url, sizePx]) => ({ url, sizePx }))
}

/** 设计像素尺寸 → MapLibre `icon-size` 倍数（图片按 1:1 像素注册，28px 的图就是 28/24 倍） */
function iconScale(sizePx?: [number, number]): number {
  const [w, h] = sizePx ?? DEFAULT_ICON_SIZE_PX
  const base = Math.max(1, DEFAULT_ICON_SIZE_PX[0])
  return Math.max(0.05, Math.min(8, Math.max(w, h) / base))
}

function renderDrones(items: DroneItem[]) {
  const map = mapInstance.current
  const urls = wantedIcons(items)

  if (!urls.length) {
    // 没有位图诉求（未配样式 / useIcon=false / url 缺失 / 已知坏图）：
    // 一次画点落库，与改造前同一条路径
    degradedIcons.clear()
    pendingIcons = false
    const feats = droneFeatures(items, new Set())
    lastDroneRenderMode = { icon: 0, point: feats.length }
    LayerManager.setUavFeatures(fc(feats))
    return
  }

  // 已经注册进 MapLibre 的图片立刻可用（换底图重建样式后重放也走这条）
  const ready = new Set(urls.map((u) => iconImageName(u.url)).filter((n) => !!map?.hasImage(n)))
  const allReady = ready.size === urls.length
  const feats = droneFeatures(items, ready)
  degradedIcons.clear()
  const iconN = feats.filter((f) => (f.properties as { hasIcon?: boolean })?.hasIcon).length
  lastDroneRenderMode = { icon: iconN, point: feats.length - iconN }
  LayerManager.setUavFeatures(fc(feats))

  if (allReady) { pendingIcons = false; return }

  // 图片还没齐：异步加载，成功后自动重落一次数据（成功的升为位图，失败的继续画点）
  const key = urls.map((u) => u.url).sort().join('|')
  if (pendingIcons && pendingIconKey === key) return
  pendingIcons = true
  pendingIconKey = key
  void ensureMarkerImages(map, urls).then((ok) => {
    pendingIcons = false
    for (const u of urls) if (!ok.has(iconImageName(u.url))) badIconUrls.add(u.url)
    const still = [...bags.drone.values()].filter((it) => (it as { visible?: boolean }).visible !== false) as DroneItem[]
    if (still.length) renderDrones(still)
    else LayerManager.setUavFeatures(fc([]))
  })
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

  // -------------------------------------------------------------- 样式配置（本批新增，可选能力）
  /**
   * 登记"位图图标 + 缺省画点 + 轨迹线宽"的样式配置。**纯可选**：
   * 不调用它时，无人机与轨迹的渲染结果与改造前逐字节一致。
   *
   * 形状与 `map-style.json` 一致，可直接把该 JSON 传进来（未识别字段会被忽略）。
   * 传 `null` 等价于"清除配置、回到未配置状态"。登记后立即重画 drone / track 两类。
   *
   * @example
   * MapDraw.setStyle(config)   // config = 读取 map-style.json 得到的对象
   */
  setStyle(config: MapStyleConfig | null): MapStyleConfig | null {
    const next = setStyleConfig(config)
    // 换配置 = 明确表达"用新的样式重来一次"，因此把此前失败的图标重新纳入尝试范围
    // （否则"先坏后好"的场景会永远停在画点上，见 examples/marker-style-acceptance.mjs 的 ②/③ 段）
    retryIconLoads()
    if (layersAvailable()) {
      renderKind('drone')
      renderKind('track')
    }
    return next
  },

  /** 重新尝试此前加载失败的位图图标（图标服务恢复后调用；随后 `render()` 即可生效） */
  retryIconLoads(): void {
    retryIconLoads()
    if (layersAvailable()) renderKind('drone')
  },

  /** 读取当前样式配置（副本；未配置返回 null） */
  getStyle(): MapStyleConfig | null {
    return styleConfig()
  },

  /**
   * 位图图标的加载统计 —— 用于确认"降级为点**并计数**"。
   * `failed` = 累计加载失败次数（每次失败都会同时通过 `onIconFailure` 回调给出可读原因）。
   */
  iconStats(): { loaded: number; failed: number; degraded: number; lastMode: { icon: number; point: number } } {
    return { loaded: iconLoadCount(), failed: iconFailureCount(), degraded: degradedIcons.size, lastMode: { ...lastDroneRenderMode } }
  },

  /** 最近一次快照里"想画位图但回落成点"的图元 id → 可读原因 */
  degradedIcons(): { id: string; reason: string }[] {
    return [...degradedIcons.entries()].map(([id, reason]) => ({ id, reason }))
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
      route: this.list('route'), shape: this.list('shape'), annulus: this.list('annulus'), symbol: this.list('symbol'),
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
