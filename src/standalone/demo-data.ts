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
  // 需求 M2-DRAW-01 补全的图元：航线 / 圆形·椭圆区域 / 目标区域
  route: [
    {
      id: 'R-1', color: '#22d3ee', dashed: true, name: '光电-01 侦察航线',
      points: [[116.330, 39.940], [116.365, 39.955], [116.400, 39.950], [116.430, 39.930]],
    },
    {
      id: 'R-2', color: '#f59e0b', dashed: true, name: '雷达-02 巡逻航线',
      points: [[116.420, 39.880], [116.470, 39.895], [116.500, 39.870], [116.455, 39.850]],
    },
  ],
  shape: [
    { id: 'C-1', lng: 116.365, lat: 39.912, radiusKm: 4, color: '#38bdf8', label: '光电侦察圈 R=4km' },
    { id: 'E-1', lng: 116.470, lat: 39.905, radiusKm: 9, radiusKmMinor: 4, rotation: 35, color: '#a855f7', label: '雷达探测椭圆 9×4km' },
    { id: 'TG-1', lng: 116.452, lat: 39.878, radiusKm: 2.2, kind: 'target', color: '#ef4444', label: '目标 001 打击区' },
    { id: 'SR-1', lng: 116.361, lat: 39.842, radiusKm: 3.5, kind: 'search', label: '后勤点搜索区' },
  ],
}

// ---------------------------------------------------------------- 验收台清单
//
// 用途：`npm run dev` 打开的演示页右侧"功能验收台"用这两份清单渲染。
// 口径与《需求文档》§6 需求追踪一致：domain 对应 M2-* 域，open 是待完成条目号。

/** 已实现能力清单：验收台上每行一个可点的验证按钮 */
export interface AcceptedFeature {
  domain: string
  /** 该行验证到的需求编号 */
  ids: string
  /** 按钮文字（点一下直接调对应 API） */
  label: string
  /** 点了会看到什么（写在按钮旁，供对照） */
  expect: string
}

export const ACCEPTED_FEATURES: AcceptedFeature[] = [
  { domain: '漫游与视角', ids: 'M2-MAP-01~07', label: '飞回北京 z12', expect: '视角平滑移动；拖拽/滚轮/双击可用；方向恒正北（二维锁定）' },
  { domain: '漫游与视角', ids: 'M2-MAP-04', label: '定位到目标 001', expect: '镜头飞到该目标并放大到 z14' },
  { domain: '控件按需显示', ids: 'M2-CTRL-01~05', label: '开启全部控件', expect: '指北针/经纬度/缩放按钮/比例尺 同时出现（默认都不显示）' },
  { domain: '控件按需显示', ids: 'M2-CTRL-01~05', label: '关闭全部控件', expect: '四类控件立即消失；地图上只剩底图与图元' },
  { domain: '图层分组', ids: 'M2-LAYER-01', label: '打开图层面板', expect: '11 个分组可逐个开关；开关状态跨底图切换保留' },
  { domain: '图元（11 类）', ids: 'M2-DRAW-01', label: '只画目标', expect: '地图只剩 3 个目标点（其余类型被清空）' },
  { domain: '图元（11 类）', ids: 'M2-DRAW-01', label: '只画航线', expect: '两条虚线航线（青=侦察、琥珀=巡逻）' },
  { domain: '图元（11 类）', ids: 'M2-DRAW-01', label: '只画圆形/椭圆/目标区', expect: '蓝圆 4km、紫椭圆 9×4km(35°)、红目标区、黄虚线搜索区' },
  { domain: '图元（11 类）', ids: 'M2-DRAW-01', label: '只画扫描与脉冲', expect: '扫描覆盖圈 + 目标外围扩散脉冲动画' },
  { domain: '图元（11 类）', ids: 'M2-DRAW-01', label: '载入全部示例', expect: '11 类图元同时出现' },
  { domain: '图元显隐', ids: 'M2-DRAW-03', label: '隐藏目标 001', expect: '该目标消失，但数据仍在（计数不变）' },
  { domain: '图元显隐', ids: 'M2-DRAW-03', label: '恢复显示', expect: '目标 001 重新出现' },
  { domain: '批量提交', ids: 'M2-API-07', label: '批量加 2000 个点', expect: '一次提交只渲染一帧（结果显示耗时与提交次数）' },
  { domain: '瓦片精度', ids: 'M2-BASE-05', label: '限制到 1km/像素', expect: '源 maxzoom 降到约 z7；继续放大不再请求更细瓦片' },
  { domain: '瓦片精度', ids: 'M2-BASE-05', label: '取消精度限制', expect: '源 maxzoom 恢复 14，重新按需请求' },
  { domain: '底图管理', ids: 'M2-BASE-09~12', label: '切到「路网」底图', expect: '整幅替换为路网模板（未自备 tiles/road 时是缺口底色，但视角与图元保持）' },
  { domain: '底图管理', ids: 'M2-BASE-09~12', label: '切回「卫星影像」', expect: '整幅换回影像；图元、图层开关、控件开关都不丢' },
  { domain: '底图管理', ids: 'M2-API-11', label: '切不存在的底图', expect: '返回可读失败原因，当前底图不变、不抛异常' },
  { domain: '图元事件', ids: 'M2-DRAW-13', label: '订阅点击（看提示）', expect: '订阅后点任意图元，右上角显示 kind:id；点空白无反应' },
  { domain: '错误边界', ids: 'M2-NFR-10', label: '注入 3 条脏数据', expect: '脏数据逐条跳过并上报，合法图元照常渲染' },
  { domain: '运行指标', ids: 'M2-CTRL-15', label: '刷新指标', expect: '显示帧率/各类图元数/瓦片缓存/最近提交耗时/JS 堆' },
]

/** 待完成清单（与《需求文档》§6 一致，共 35 条） */
export interface OpenItem {
  domain: string
  /** 该域待完成的条目号 */
  open: string
  count: number
  summary: string
}

export const OPEN_ITEMS: OpenItem[] = [
  { domain: 'M2-MAP 地图能力', open: '08–10', count: 3, summary: '军用网格与经纬网、多底图整体切换（切换能力已具备，网格待做）、瓦片源自动降级' },
  { domain: 'M2-CTRL 地图控件', open: '09–14', count: 6, summary: '显示模式手动切换、量算（测距/测面/方位角）、地图内图例、图层排序与透明度、主题热切换、键盘操作' },
  { domain: 'M2-BASE 底图', open: '08、13', count: 2, summary: '瓦片包版本与完整性校验；精度上限只作用本地底图的显式验证' },
  { domain: 'M2-DRAW 绘制接口', open: '08–12、14–18', count: 10, summary: '手绘交互与图元编辑、圈层图元（距离环/方位线）、目标聚合、标签避让、吸附对齐、样式模板、国军标符号库、时间轴回放' },
  { domain: 'M2-API 对外接口', open: '08、09、14–17', count: 6, summary: '视图状态序列化、图片导出、接口最小示例、接口稳定性约定、回放控制接口、第三方接入指南' },
  { domain: 'M2-NFR 非功能性', open: '06–09、11–14', count: 8, summary: '底图加载观感、性能基线维护、资源上限、移动端手势、多实例隔离、图元容量指标、大数据量降级、渲染时机合并' },
]
