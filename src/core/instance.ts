// 地图模块 · MapLibre 实例的模块内单例引用
//
// 仅模块内部与"地图叠加控件"（指北针/工具条）使用；
// 应用侧若需主动操控视角，请用模块导出的命令式 API（见 index.ts 的 mapCommands）。
import type { Map as MlMap } from 'maplibre-gl'

export const mapInstance: { current: MlMap | null } = { current: null }
