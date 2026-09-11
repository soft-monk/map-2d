// map-2d · 对外类型契约（模块自带，不依赖任何主系统代码）
//
// 设计原则：本模块可被单独 clone / 嵌入任意项目，因此所有类型都在此定义。
// 宿主若有自己的 DTO，只要字段结构兼容即可直接传入（TS 结构化类型）。
// 额外字段一律允许（下方 [k: string]: unknown），便于宿主扩展。

// ---------------------------------------------------------------- 基础枚举
export type Phase = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7'
export type ScenarioKey = string
export type Threat = 'high' | 'mid' | 'low' | string
export type LinkState = 'green' | 'yellow' | 'red' | string
export type UavType = 'optical' | 'radar' | 'electronic' | 'comm' | string

// ---------------------------------------------------------------- 底图配置
export interface MapConfigData {
  center: [number, number]
  zoom: number
  minZoom: number
  maxZoom: number
  basemap: {
    tileUrlTemplate: string
    attribution: string
    fallback?: string
    /** 可选：直接使用在线矢量/栅格样式 URL（优先于 tileUrlTemplate，便于独立演示） */
    styleUrl?: string
  }
  /** 可选：与地图无关的透传字段（如视频通道），便于宿主复用同一配置对象 */
  video?: { name: string; url: string }[]
}

// ---------------------------------------------------------------- 业务图元数据
export interface Group {
  id: string
  name: string
  seq?: number
  optical?: number
  radar?: number
  electronic?: number
  comm?: number
  task_dir?: string
  cover_area?: string
  lng?: number
  lat?: number
}

export interface LinkEdge {
  id: string
  from_node: string
  to_node: string
  state?: LinkState
}

export interface LinkTopology {
  nodes: { id: string; name: string; kind?: string; lng?: number; lat?: number }[]
  edges: LinkEdge[]
}

export interface Target {
  id: string
  target_no?: number
  name?: string
  type?: string
  threat?: Threat
  lng: number
  lat: number
  status?: 'red' | 'yellow' | 'gray' | string
}

export interface TargetTrackPoint {
  ts?: number
  lng: number
  lat: number
}

export interface UavPosEvent {
  uavId: string
  type?: UavType
  groupId?: string
  lng: number
  lat: number
  alt?: number
  heading?: number
  speed?: number
  battery?: number
  ts?: number
}

// ---------------------------------------------------------------- 渲染数据快照
/** 每一帧渲染所需的业务数据快照（宿主组装，模块只读） */
export interface MapData {
  /** 地图初始化配置；为空时使用模块内置缺省视角 */
  config: MapConfigData | null
  scenarioKey: ScenarioKey
  phase: Phase
  /** 目标台账（含威胁配色与选中态） */
  targets: Target[]
  /** 当前选中目标（锁定框高亮） */
  selectedTargetId?: string | null
  /** 集群编组 */
  groups: Group[]
  /** 无人机实时位置（遥测） */
  uavs: UavPosEvent[]
  /** 链路边 + 拓扑节点 */
  edges: LinkEdge[]
  topology: LinkTopology | null
  /** 目标轨迹点（轨迹回溯） */
  track: TargetTrackPoint[]
}

// ---------------------------------------------------------------- UI 状态
export type MapToolKey = 'select' | 'measure' | 'layer' | 'area' | 'new' | 'clear' | 'full' | 'draw' | 'reset'

export interface MapViewport {
  lng: number
  lat: number
  zoom: number
  bearing: number
}
