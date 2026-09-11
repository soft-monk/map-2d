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

export { useMapUiStore, LAYER_GROUPS } from './core/store'
export { LayerManager, LAYER_GROUP_LABELS, ALL_LAYER_GROUPS } from './render/LayerManager'
export type { LayerGroup } from './render/LayerManager'
export { DISPLAY_MODE, displayModeOf } from './core/displayMode'
export { MAP_OPTIONS } from './core/options'
export type { MapOptions } from './core/options'
export { mapInstance } from './core/instance'
export { mapCommands } from './core/commands'

// 绘制 API（图元驱动渲染：无人机/区域/目标/链路/轨迹/扫描/脉冲/标注…）
export { MapDraw } from './primitives/api'
export type {
  PrimitiveKind, AreaItem, DroneItem, TargetItem, LinkItem, TrackItem,
  ScanItem, PulseItem, ClusterItem, LabelItem, DrawSnapshot,
} from './primitives/api'

export type { MapData, MapToolKey, MapViewport, MapConfigData, Group, LinkEdge, LinkTopology, Target, TargetTrackPoint, UavPosEvent, Phase, ScenarioKey } from './core/types'
