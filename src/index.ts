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

// 绘制 API（图元驱动渲染：无人机/区域/目标/链路/轨迹/扫描/脉冲/标注…）
export { MapDraw } from './primitives/api'
export type {
  PrimitiveKind, AreaItem, DroneItem, TargetItem, LinkItem, TrackItem,
  ScanItem, PulseItem, ClusterItem, LabelItem, DrawSnapshot,
} from './primitives/api'

export type { MapData, MapToolKey, MapViewport, MapConfigData, Group, LinkEdge, LinkTopology, Target, TargetTrackPoint, UavPosEvent, Phase, ScenarioKey } from './core/types'
