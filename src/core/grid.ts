// map-2d · 军事网格与经纬网（需求 M2-MAP-08）
//
// 两部分：
//   ① 坐标换算：WGS84 → UTM（带号/东距/北距）→ MGRS 军用格网参考（自己实现，不引依赖）
//   ② 网格叠加：按当前缩放选间隔画经纬网/UTM 网格线，并在交点上标注坐标
//
// 换算公式取自标准横轴墨卡托（Transverse Mercator）投影，中央经线比例因子 0.9996，
// 精度对本模块的态势显示足够（厘米级以上误差与本用途无关）。
import { mapInstance } from './instance'
import { useMapUiStore } from './store'
import type { LngLat } from './geometry'

const RAD = Math.PI / 180

/** UTM 带号（1–60）与半球 */
export function utmZone(lng: number, lat: number): { zone: number; band: string; hemisphere: 'N' | 'S' } {
  const zone = Math.floor((lng + 180) / 6) + 1
  // 纬度带字母：C–X（不含 I、O）
  const bands = 'CDEFGHJKLMNPQRSTUVWX'
  const idx = Math.max(0, Math.min(bands.length - 1, Math.floor((lat + 80) / 8)))
  return { zone, band: bands[idx], hemisphere: lat >= 0 ? 'N' : 'S' }
}

/** WGS84 → UTM 平面坐标（米） */
export function toUTM(lng: number, lat: number): { zone: number; easting: number; northing: number; hemisphere: 'N' | 'S' } {
  const a = 6378137.0
  const f = 1 / 298.257223563
  const e2 = 2 * f - f * f
  const k0 = 0.9996
  const { zone, hemisphere } = utmZone(lng, lat)

  const lon0 = ((zone - 1) * 6 - 180 + 3) * RAD
  const phi = lat * RAD
  const lam = lng * RAD

  const ep2 = e2 / (1 - e2)
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T = Math.tan(phi) ** 2
  const C = ep2 * Math.cos(phi) ** 2
  const A = Math.cos(phi) * (lam - lon0)

  const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi))

  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000

  let northing = k0 * (M + N * Math.tan(phi) * ((A * A) / 2
    + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720))
  if (lat < 0) northing += 10000000

  return { zone, easting, northing, hemisphere }
}

/** MGRS 列字母（100km 方格，I/O 跳过） */
const MGRS_COL = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
/** 行字母（奇偶带号用不同起点） */
const MGRS_ROW_EVEN = 'FGHJKLMNPQRSTUV'
const MGRS_ROW_ODD = 'ABCDEFGHJKLMNPQRST'

/**
 * WGS84 → MGRS 格网参考（如 `50TMK 12345 67890`）。
 * `precision` 为末段位数（1–5，默认 5 = 1 米）。
 */
export function toMGRS(lng: number, lat: number, precision = 5): string {
  const { zone, band } = utmZone(lng, lat)
  const { easting, northing } = toUTM(lng, lat)
  const e100k = Math.floor(easting / 100000)
  const n100k = Math.floor(northing / 100000)
  const colIdx = (e100k - 1) % 8
  const colLetter = MGRS_COL[colIdx]
  const rowSet = zone % 2 === 0 ? MGRS_ROW_EVEN : MGRS_ROW_ODD
  const rowLetter = rowSet[n100k % 20]
  const e = Math.floor(easting % 100000)
  const n = Math.floor(northing % 100000)
  const p = Math.max(1, Math.min(5, precision))
  const tail = 5 - p
  const eStr = String(Math.floor(e / 10 ** tail)).padStart(p, '0')
  const nStr = String(Math.floor(n / 10 ** tail)).padStart(p, '0')
  return `${zone}${band} ${colLetter}${rowLetter} ${eStr} ${nStr}`
}

/** 当前光标/中心的坐标读数（经纬度 + UTM + MGRS） */
export function coordinateReadout(lng: number, lat: number) {
  const utm = toUTM(lng, lat)
  return {
    lng, lat,
    utm: { zone: utm.zone, hemisphere: utm.hemisphere, easting: Math.round(utm.easting), northing: Math.round(utm.northing) },
    mgrs: toMGRS(lng, lat),
    zoneBand: `${utm.zone}${utmZone(lng, lat).band}`,
  }
}

// ---------------------------------------------------------------- 网格叠加

/** 网格类型：经纬网 / UTM 方格 */
export type GridKind = 'none' | 'graticule' | 'utm'

const SRC_GRID = 'src-2d-grid'
const LYR_GRID = 'lyr-2d-grid'
const LYR_GRID_LABEL = 'lyr-2d-grid-label'

/** 按缩放选择经纬网间隔（度） */
function intervalForZoom(zoom: number): number {
  if (zoom >= 13) return 0.005
  if (zoom >= 11) return 0.01
  if (zoom >= 9) return 0.05
  if (zoom >= 7) return 0.1
  if (zoom >= 5) return 0.5
  if (zoom >= 3) return 1
  return 5
}

function gridLayersReady(map: maplibregl.Map): boolean {
  return !!map.getSource(SRC_GRID)
}

function ensureGridLayers(map: maplibregl.Map) {
  if (gridLayersReady(map)) return
  map.addSource(SRC_GRID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as never })
  map.addLayer({
    id: LYR_GRID, type: 'line', source: SRC_GRID,
    filter: ['==', ['get', 'role'], 'line'],
    paint: { 'line-color': '#7fd1ff', 'line-width': 0.8, 'line-opacity': 0.42 },
  })
  map.addLayer({
    id: LYR_GRID_LABEL, type: 'symbol', source: SRC_GRID,
    filter: ['==', ['get', 'role'], 'label'],
    layout: {
      'text-field': ['get', 'text'],
      'text-size': 10.5,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      'text-anchor': 'top-left',
    },
    paint: { 'text-color': '#cfe3f5', 'text-halo-color': 'rgba(5,10,20,.9)', 'text-halo-width': 1.6 },
  })
}

/**
 * 生成当前视野内的网格线与标注。
 * 经纬网：固定经纬度间隔（随缩放选择）；
 * UTM 方格：按 10km / 1km 间隔（随缩放），标注里带 MGRS 首段（如 `50TMK`）。
 */
export function buildGrid(map: maplibregl.Map, kind: GridKind): GeoJSON.Feature[] {
  if (kind === 'none') return []
  const b = map.getBounds()
  const zoom = map.getZoom()
  const feats: GeoJSON.Feature[] = []

  if (kind === 'graticule') {
    const step = intervalForZoom(zoom)
    const w = b.getWest()
    const e = b.getEast()
    const s = b.getSouth()
    const n = b.getNorth()
    // 限定条数，避免极端缩放下生成过多图元
    const maxLines = 60
    let count = 0
    for (let lng = Math.ceil(w / step) * step; lng <= e && count < maxLines; lng += step, count++) {
      feats.push({ type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates: [[lng, s], [lng, n]] } })
      feats.push({
        type: 'Feature',
        properties: { role: 'label', text: `${lng.toFixed(step < 1 ? 2 : 0)}°E` },
        geometry: { type: 'Point', coordinates: [lng, n] },
      })
    }
    count = 0
    for (let lat = Math.ceil(s / step) * step; lat <= n && count < maxLines; lat += step, count++) {
      feats.push({ type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates: [[w, lat], [e, lat]] } })
      feats.push({
        type: 'Feature',
        properties: { role: 'label', text: `${lat.toFixed(step < 1 ? 2 : 0)}°N` },
        geometry: { type: 'Point', coordinates: [w, lat] },
      })
    }
    return feats
  }

  // UTM 方格：以中心点的 UTM 坐标为基准，按整公里取整（10km 或 1km）
  const center = map.getCenter()
  const c = toUTM(center.lng, center.lat)
  const stepM = zoom >= 12 ? 1000 : zoom >= 9 ? 5000 : 10000
  const prefix = toMGRS(center.lng, center.lat).split(' ')[0]   // 如 50TMK
  // 屏幕像素 → 米（用于控制线数）
  const mpp = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom
  const halfSpanM = ((map.getCanvas().width || 1200) / 2) * mpp
  const halfLines = Math.min(24, Math.ceil(halfSpanM / stepM))

  const e0 = Math.floor(c.easting / stepM) * stepM
  const n0 = Math.floor(c.northing / stepM) * stepM
  for (let i = -halfLines; i <= halfLines; i++) {
    const eM = e0 + i * stepM
    const nM = n0 + i * stepM
    // 用近似换算回经纬度：1° 经度 ≈ 111320·cos(lat) 米，1° 纬度 ≈ 110574 米
    const kx = 111320 * Math.cos((center.lat * Math.PI) / 180)
    const ky = 110574
    const lngAt = center.lng + (eM - c.easting) / kx
    const latAt = center.lat + (nM - c.northing) / ky
    feats.push({ type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates: [[lngAt, b.getSouth()], [lngAt, b.getNorth()]] } })
    feats.push({ type: 'Feature', properties: { role: 'line' }, geometry: { type: 'LineString', coordinates: [[b.getWest(), latAt], [b.getEast(), latAt]] } })
    if (i % 2 === 0) {
      feats.push({
        type: 'Feature',
        properties: { role: 'label', text: `${prefix} ${Math.round(eM / 1000)}` },
        geometry: { type: 'Point', coordinates: [lngAt, b.getNorth()] },
      })
      feats.push({
        type: 'Feature',
        properties: { role: 'label', text: `${prefix} ${Math.round(nM / 1000)}` },
        geometry: { type: 'Point', coordinates: [b.getWest(), latAt] },
      })
    }
  }
  return feats
}

/** 刷新网格（网格类型变化、视野变化时调用） */
export function refreshGrid(map = mapInstance.current as maplibregl.Map | null): void {
  if (!map) return
  const kind = useMapUiStore.getState().grid
  if (kind === 'none') {
    if (map.getSource(SRC_GRID)) {
      ;(map.getSource(SRC_GRID) as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] } as never)
    }
    return
  }
  ensureGridLayers(map)
  const src = map.getSource(SRC_GRID) as maplibregl.GeoJSONSource | undefined
  src?.setData({ type: 'FeatureCollection', features: buildGrid(map, kind) } as never)
  // 网格是"看坐标"的辅助层，应压在业务图层之下
  if (map.getLayer(LYR_GRID) && map.getLayer('lyr-area-fill')) {
    try { map.moveLayer(LYR_GRID, 'lyr-area-fill') } catch { /* 顺序异常时忽略 */ }
    try { map.moveLayer(LYR_GRID_LABEL, 'lyr-area-fill') } catch { /* 同上 */ }
  }
}

/** 设置网格类型（none / graticule / utm） */
export function setGridKind(kind: GridKind): GridKind {
  useMapUiStore.getState().setGrid(kind)
  refreshGrid()
  return kind
}

/** 当前网格类型 */
export function gridKind(): GridKind {
  return useMapUiStore.getState().grid
}

/** 清掉网格图层（样式重建后由 MapView 重新建） */
export function resetGridLayers() {
  refreshGrid()
}
