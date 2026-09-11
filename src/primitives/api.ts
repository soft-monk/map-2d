// map-2d · 绘制 API —— 「渲染 + API 驱动」的核心
//
// 用途：宿主不关心 MapLibre 的 source/layer 细节，只用本 API 增删改查图元：
//   MapDraw.set('area', [...]) / add('drone', {...}) / remove('target', 'T-1') / clear('link')
// 数据与样式解耦：图元自带 color/label 等属性；未给则用本文件的内置调色板。
//
// 说明：本层只做「数据 → GeoJSON → LayerManager」的转换与集合管理，
// 不涉及鼠标手绘交互（手绘留待后续版本）。
import { mapInstance } from '../core/instance'
import { LayerManager } from '../render/LayerManager'
import type { LinkState, Threat, UavType } from '../core/types'

// ---------------------------------------------------------------- 图元类型
export type PrimitiveKind = 'area' | 'drone' | 'target' | 'link' | 'track' | 'scan' | 'pulse' | 'cluster' | 'label'

export interface AreaItem {
  id: string
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
  lng: number
  lat: number
  type?: UavType
  color?: string
  label?: string
}

export interface TargetItem {
  id: string
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
  from: [number, number]
  to: [number, number]
  state?: LinkState
  color?: string
  label?: string
}

export interface TrackItem {
  id: string
  points: [number, number][]
  color?: string
  dashed?: boolean
}

export interface ScanItem {
  id: string
  lng: number
  lat: number
  /** 覆盖半径（公里，按当前缩放换算为像素） */
  radiusKm: number
  color?: string
  label?: string
}

export interface PulseItem {
  id: string
  lng: number
  lat: number
  color?: string
  radiusKm?: number
}

export interface ClusterItem {
  id: string
  lng: number
  lat: number
  name?: string
  color?: string
}

export interface LabelItem {
  id: string
  lng: number
  lat: number
  text: string
  color?: string
  /** 字号（px） */
  size?: number
  /** 圆点半径（px），0 表示只画文字 */
  radius?: number
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
}

// ---------------------------------------------------------------- 内部集合
type AnyItem = AreaItem | DroneItem | TargetItem | LinkItem | TrackItem | ScanItem | PulseItem | ClusterItem | LabelItem

const bags: Record<PrimitiveKind, Map<string, AnyItem>> = {
  area: new Map(), drone: new Map(), target: new Map(), link: new Map(),
  track: new Map(), scan: new Map(), pulse: new Map(), cluster: new Map(), label: new Map(),
}

/** 公里 → 像素（Web Mercator，按当前缩放） */
function kmToPixels(km: number, lat: number): number {
  const zoom = mapInstance.current?.getZoom() ?? 11
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

// ---------------------------------------------------------------- 渲染
function renderKind(kind: PrimitiveKind) {
  const items = [...bags[kind].values()]
  switch (kind) {
    case 'area':
      LayerManager.setAreaFeatures(fc((items as AreaItem[]).map((a) =>
        polygon(a.polygon, { color: a.color ?? C.area, label: a.label ?? '', opacity: a.opacity ?? 0.1 }))))
      break
    case 'drone':
      LayerManager.setUavFeatures(fc((items as DroneItem[]).map((d) =>
        point(d.lng, d.lat, { label: d.label ?? d.id, color: d.color ?? C.drone[d.type ?? ''] ?? C.area }))))
      break
    case 'target':
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
        line([l.from, l.to], { color: l.color ?? C.link[l.state ?? ''] ?? C.link.green, state: l.state ?? 'green', name: l.label ?? l.id }))))
      break
    case 'track':
      LayerManager.setTrackFeatures(fc((items as TrackItem[]).map((t) =>
        line(t.points, { color: t.color ?? C.track, dashed: t.dashed ?? true }))))
      break
    case 'scan':
      LayerManager.setScanFeatures(fc((items as ScanItem[]).map((s) =>
        point(s.lng, s.lat, {
          color: s.color ?? C.scan,
          r: kmToPixels(s.radiusKm, s.lat),
          label: s.label ?? '',
        }))))
      break
    case 'pulse':
      LayerManager.setPulseSeedsPublic((items as PulseItem[]).map((p) => ({
        lng: p.lng, lat: p.lat, color: p.color ?? C.pulse,
      })))
      break
    case 'cluster':
      LayerManager.setGroupFeatures(fc((items as ClusterItem[]).map((c) =>
        point(c.lng, c.lat, { name: c.name ?? c.id, color: c.color ?? C.cluster }))))
      break
    case 'label':
      LayerManager.setMarkers(fc((items as LabelItem[]).map((m) =>
        point(m.lng, m.lat, { text: m.text, color: m.color ?? C.label, size: m.size ?? 11, r: m.radius ?? 0 }))))
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
    if (bags.scan.size > 0) renderKind('scan')
  })
  zoomHooked = true
}

// ---------------------------------------------------------------- 公开 API
export const MapDraw = {
  /** 整组替换某类图元 */
  set<K extends PrimitiveKind>(kind: K, items: DrawSnapshot[K]) {
    bags[kind].clear()
    ;(items as AnyItem[]).forEach((it) => bags[kind].set(it.id, it))
    ensureZoomHook()
    renderKind(kind)
  },

  /** 新增或更新单个图元 */
  add<K extends PrimitiveKind>(kind: K, item: DrawSnapshot[K][number]) {
    bags[kind].set(item.id, item)
    ensureZoomHook()
    renderKind(kind)
  },

  /** 删除单个图元 */
  remove(kind: PrimitiveKind, id: string) {
    if (bags[kind].delete(id)) renderKind(kind)
  },

  /** 清空某类（不传 kind 则清空全部图元并清掉地图上所有动态图层） */
  clear(kind?: PrimitiveKind) {
    if (!kind) {
      ;(Object.keys(bags) as PrimitiveKind[]).forEach((k) => bags[k].clear())
      LayerManager.clearAll()
      return
    }
    bags[kind].clear()
    renderKind(kind)
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
