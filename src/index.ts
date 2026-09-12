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
// 瓦片源降级（M2-MAP-10）与瓦片包校验（M2-BASE-08）
export {
  bindTileFallback, unbindTileFallback, tileState, isDegraded, onTilesDegraded,
  resetTileFallback, TILES_DEGRADED_EVENT,
} from './core/tileFallback'
export type { TileDegradeState } from './core/tileFallback'
export { validateTiles, missingTilesFrom } from './core/tileValidation'
export type { TileManifest, ValidationReport, ValidationCheck } from './core/tileValidation'
// 军事网格与坐标换算（M2-MAP-08）
export {
  utmZone, toUTM, toMGRS, coordinateReadout, buildGrid, refreshGrid, setGridKind, gridKind,
} from './core/grid'
export type { GridKind } from './core/grid'
// 显示模式（M2-CTRL-08 / 09）：阶段自动推导 + 宿主手动覆盖
export {
  syncDisplayMode, setDisplayModeManual, clearDisplayModeOverride, displayModeState,
  availableDisplayModes, resetDisplayMode,
} from './core/displayModeState'
export type { DisplayModeState } from './core/displayModeState'
// 国军标标绘符号库（M2-DRAW-16）
export {
  SYMBOLS, AFFILIATION_COLOR, registerSymbol, symbolNames, symbolSvg, imageName, ensureSymbolImages,
} from './core/symbols'
export type { SymbolDef, SymbolKey, SymbolAffiliation } from './core/symbols'
// 命名样式模板与主题（M2-DRAW-15 / M2-CTRL-13）
export {
  setStyleTemplates, defineStyle, removeStyle, styleNames, getStyle, clearStyles, resolveStyle,
  applyTheme, getTheme, currentThemeKey, reapplyTheme, THEMES,
} from './core/theme'
export type { StyleTemplate, ThemeKey, ThemeDef } from './core/theme'
// 圈层类图元（M2-DRAW-09）：距离环/方位线/方位圈/九宫格
export { annulusToLines, circleRing, bearingRay, gridLines, bearingRingTicks } from './core/annulus'
export type { AnnulusItem, AnnulusKind } from './core/annulus'
// 聚合与标签策略（M2-DRAW-10 / 11）
export { setClusterOptions, getClusterOptions, clusterStats, setLabelPolicy, getLabelPolicy, clusterPoints, filterLabels } from './core/clustering'
export type { ClusterOptions, ClusterStats, LabelPolicy } from './core/clustering'
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
