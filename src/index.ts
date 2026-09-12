// map-2d · 唯一公开入口
//
// 宿主只允许从此处导入；src/ 下的其它文件都属于实现细节。
//
// 两种用法：
//   ① 嵌入式（主系统）：<MapView data={mapData} /> + MapToolbar/Compass，或用 Draw API 直接画
//   ② 独立运行（演示/交付）：见 standalone/（npm run dev 直接出图）
export { MapView } from './ui/MapView'
export { MapToolbar, MapModeBadge } from './ui/MapToolbar'
export { LayerPanel } from './ui/LayerPanel'
export { Compass } from './ui/Compass'
export { CoordReadout } from './ui/CoordReadout'
// 地图内图例（M2-CTRL-11）：内容取自图元真实配色来源
export { Legend, DEFAULT_LEGEND } from './ui/Legend'
// 交互层：手绘 / 图元编辑 / 量算（M2-DRAW-08/12/14、M2-CTRL-10）
export { DrawLayer } from './ui/DrawLayer'
// 回放：模块给时间轴与播放控制，数据与存储由宿主提供（M2-DRAW-17/18、M2-API-16）
export { ReplayBar, replayStatus } from './ui/ReplayBar'
export {
  useReplay, loadReplay, clearReplay, play, pause, toggle, setSpeed, seek, seekProgress,
  step, setFollow, status as replayStatusValue, onReplayChange, sampleAt, sampleAll,
} from './core/replay'
export type { ReplayData, ReplayTrack, ReplaySample, ReplayState, ReplayStatus } from './core/replay'
export { useInteraction, isDrawing, DEFAULT_KIND } from './core/interaction'
export type { DrawMode, DrawKind, Measurement, EditTarget } from './core/interaction'
export {
  distanceMeters, pathLengthMeters, polygonAreaM2, bearingDeg, pointToSegmentMeters,
  fmtDistance, fmtArea, verticesOf, withVertices, isEditableShape, insertVertex, removeVertex, snapTo,
} from './core/geometry'
export type { LngLat } from './core/geometry'
// 视图状态序列化与图片导出（M2-API-08 / M2-API-09）
export { exportViewState, restoreViewState, exportImage, downloadImage } from './core/viewState'
export type { ViewState, RestoreOptions, ExportImageOptions } from './core/viewState'
// 渲染时机计数（M2-NFR-14）
export { renderTiming, recordWrite, recordRender } from './core/diagnostics'
export type { RenderTiming } from './core/diagnostics'
export type { LegendItem, LegendSection } from './ui/Legend'

export { useMapUiStore, LAYER_GROUPS } from './core/store'
export { LayerManager, LAYER_GROUP_LABELS, ALL_LAYER_GROUPS } from './render/LayerManager'
export type { LayerGroup } from './render/LayerManager'
export { DISPLAY_MODE, displayModeOf } from './core/displayMode'
export { MAP_OPTIONS, ALL_CONTROL_KEYS, metersPerPixelToZoom, zoomToMetersPerPixel } from './core/options'
export type { MapOptions, MapControlKey } from './core/options'
export { mapInstance } from './core/instance'
export { mapCommands } from './core/commands'

// 控件按需显示（M2-CTRL-01 ~ 05）：默认全不显示，按需开启
export { setControl, showControls, toggleControl, visibleControls, controlState, applyControls } from './core/controls'

// 瓦片精度上限（M2-BASE-05）：按地面分辨率设限，默认不限制，只作用于本地栅格底图
export { tileMaxZoomFromOptions, applyTilePrecision, TILE_DATA_MAX_ZOOM } from './core/tilePrecision'

// 底图管理（M2-MAP-09 / M2-BASE-09 ~ 13 / M2-API-10 ~ 13）：
// 多套本地底图可枚举、可切换（整幅替换）、切换后状态保持，并对外提供通知
export { basemaps, initialBasemapConfig, BASEMAP_CHANGE_EVENT } from './core/basemaps'
export type { BasemapDef, BasemapInfo, BasemapListener } from './core/basemaps'

// 图元事件（M2-DRAW-13）：点击/悬停回调只带图元身份，空白处不触发
export {
  onPrimitiveEvent, bindPrimitiveEvents, unbindPrimitiveEvents, clearPrimitiveHandlers,
  pickAt, primitiveHandlerCounts,
} from './core/primitiveEvents'
export type { PrimitiveEvent, PrimitiveEventName } from './core/primitiveEvents'

// 运行指标与错误上报（M2-CTRL-15 / M2-NFR-10 / M2-NFR-11）
export {
  stats as runtimeStats, onPrimitiveError, recentErrors, resetDiagnostics,
  startFpsCounter, stopFpsCounter, setPrimitiveCounter, recordSubmit, reportPrimitiveError,
} from './core/diagnostics'
export type { RuntimeStats, PrimitiveError } from './core/diagnostics'

// 绘制 API（图元驱动渲染：无人机/区域/目标/链路/轨迹/扫描/脉冲/标注…）
export { MapDraw } from './primitives/api'
export type {
  PrimitiveKind, AreaItem, DroneItem, TargetItem, LinkItem, TrackItem,
  ScanItem, PulseItem, ClusterItem, LabelItem, DrawSnapshot,
} from './primitives/api'

export type { MapData, MapToolKey, MapViewport, MapConfigData, Group, LinkEdge, LinkTopology, Target, TargetTrackPoint, UavPosEvent, Phase, ScenarioKey } from './core/types'
