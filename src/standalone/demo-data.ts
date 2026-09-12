// map-2d · 独立宿主示例数据（纯静态，不依赖任何后端）
//
// 用途：`npm run dev` 打开即能看到"无人机 / 区域 / 目标 / 链路 / 轨迹 / 扫描 / 标注"
// 全部图元长什么样，也当作 Draw API 的用法示例。
import type { DrawSnapshot } from '../primitives/api'
import type { MapConfigData } from '../core/types'
import type { BasemapDef } from '../core/basemaps'

/** 演示中心（北京） */
const C: [number, number] = [116.3974, 39.9093]

/** 底图方案：本地瓦片 / 在线样式（两者都支持） */
export const DEMO_BASEMAPS: Record<string, { label: string; config: MapConfigData }> = {
  local: {
    label: '本地瓦片（服务端 /tiles）',
    config: {
      center: C, zoom: 12, minZoom: 3, maxZoom: 18,
      basemap: {
        tileUrlTemplate: '/tiles/raster/{z}/{x}/{y}.jpg',
        attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
    },
  },
  demotiles: {
    label: '在线 · MapLibre demotiles',
    config: {
      center: C, zoom: 12, minZoom: 1, maxZoom: 18,
      basemap: { tileUrlTemplate: '', attribution: '', styleUrl: 'https://demotiles.maplibre.org/style.json' },
    },
  },
  openfreemap: {
    label: '在线 · OpenFreeMap Liberty',
    config: {
      center: C, zoom: 12, minZoom: 1, maxZoom: 18,
      basemap: { tileUrlTemplate: '', attribution: '', styleUrl: 'https://tiles.openfreemap.org/styles/liberty' },
    },
  },
  cartoDark: {
    label: '在线 · CARTO 深色',
    config: {
      center: C, zoom: 12, minZoom: 1, maxZoom: 18,
      basemap: {
        tileUrlTemplate: '', attribution: '',
        styleUrl: 'https://tiles.basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      },
    },
  },
}

/**
 * 底图注册表用的清单（M2-BASE-09 ~ 13 / M2-API-10 ~ 13 的演示数据）。
 *
 * 独立宿主用它演示"多套底图可枚举、可切换、整幅替换"——
 * 真实项目里这份清单可以写在前端配置，也可以启动时从后端接口拉（模块只消费清单）。
 * 第二项是"路网"的占位：把 `tiles` 指到本地路网瓦片目录即可真实生效
 * （没有该目录时切过去会看到缺口底色，说明"整幅替换"确实发生了）。
 */
export const DEMO_BASEMAP_DEFS: BasemapDef[] = [
  {
    id: 'satellite',
    name: DEMO_BASEMAPS.local.label,
    type: 'raster',
    tiles: '/tiles/raster/{z}/{x}/{y}.jpg',
    minZoom: 3, maxZoom: 14,
    attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  {
    id: 'road',
    name: '本地 · 路网（需自备 tiles/road）',
    type: 'raster',
    tiles: '/tiles/road/{z}/{x}/{y}.png',
    minZoom: 3, maxZoom: 16,
  },
  {
    id: 'demotiles',
    name: DEMO_BASEMAPS.demotiles.label,
    type: 'style',
    styleUrl: 'https://demotiles.maplibre.org/style.json',
  },
  {
    id: 'openfreemap',
    name: DEMO_BASEMAPS.openfreemap.label,
    type: 'style',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  },
  {
    id: 'cartoDark',
    name: DEMO_BASEMAPS.cartoDark.label,
    type: 'style',
    styleUrl: 'https://tiles.basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
]

/** 示例图元：覆盖 Draw API 的全部 9 类 */
export const DEMO_SNAPSHOT: DrawSnapshot = {
  area: [
    {
      id: 'A-1', label: 'A 区（蓝）', color: '#3b82f6', opacity: 0.10,
      polygon: [[116.30, 39.94], [116.42, 39.95], [116.44, 39.88], [116.31, 39.87]],
    },
    {
      id: 'B-1', label: 'B 区（绿）', color: '#22c55e', opacity: 0.10,
      polygon: [[116.44, 39.93], [116.53, 39.94], [116.52, 39.86], [116.43, 39.87]],
    },
    {
      id: 'C-1', label: 'C 区（红·高危）', color: '#ef4444', opacity: 0.12,
      polygon: [[116.33, 39.86], [116.44, 39.86], [116.45, 39.80], [116.34, 39.80]],
    },
  ],
  cluster: [
    { id: 'G-1', lng: 116.365, lat: 39.912, name: '前出侦察集群' },
    { id: 'G-2', lng: 116.470, lat: 39.905, name: '雷达探测集群', color: '#f59e0b' },
    { id: 'G-3', lng: 116.392, lat: 39.845, name: '机动预备集群', color: '#22c55e' },
  ],
  drone: [
    { id: 'U-1', lng: 116.378, lat: 39.920, type: 'optical', label: '光电-01' },
    { id: 'U-2', lng: 116.392, lat: 39.930, type: 'radar', label: '雷达-02' },
    { id: 'U-3', lng: 116.410, lat: 39.915, type: 'electronic', label: '电子-03' },
    { id: 'U-4', lng: 116.430, lat: 39.900, type: 'comm', label: '通信-04' },
  ],
  target: [
    { id: 'T-1', lng: 116.452, lat: 39.878, threat: 'high', status: 'red', label: '目标 001 · 指挥节点', selected: true },
    { id: 'T-2', lng: 116.470, lat: 39.890, threat: 'mid', status: 'yellow', label: '目标 002 · 通信枢纽' },
    { id: 'T-3', lng: 116.361, lat: 39.842, threat: 'low', status: 'gray', label: '目标 003 · 后勤点' },
  ],
  link: [
    { id: 'L-1', from: [116.365, 39.912], to: [116.452, 39.878], state: 'green', label: '指挥链路' },
    { id: 'L-2', from: [116.470, 39.905], to: [116.452, 39.878], state: 'yellow', label: '弱链路' },
    { id: 'L-3', from: [116.392, 39.845], to: [116.361, 39.842], state: 'green' },
  ],
  track: [
    {
      id: 'TR-1', color: '#ef4444',
      points: [[116.430, 39.905], [116.440, 39.895], [116.448, 39.886], [116.452, 39.878]],
    },
  ],
  scan: [
    { id: 'S-1', lng: 116.365, lat: 39.912, radiusKm: 6, label: '光电侦察覆盖' },
    { id: 'S-2', lng: 116.470, lat: 39.905, radiusKm: 9, color: '#a855f7', label: '雷达探测覆盖' },
  ],
  pulse: [
    { id: 'P-1', lng: 116.452, lat: 39.878, color: '#ef4444' },
    { id: 'P-2', lng: 116.470, lat: 39.890, color: '#f59e0b' },
  ],
  label: [
    { id: 'M-1', lng: 116.3974, lat: 39.9093, text: '前沿指挥节点', color: '#22d3ee', radius: 5, size: 12 },
    { id: 'M-2', lng: 116.335, lat: 39.955, text: '任务区域北界', color: '#8fb0cc', radius: 0, size: 11 },
  ],
}
