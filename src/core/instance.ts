// 地图模块 · MapLibre 实例的模块内单例引用
//
// 仅模块内部与"地图叠加控件"（指北针/工具条）使用；
// 应用侧若需主动操控视角，请用模块导出的命令式 API（见 index.ts 的 mapCommands）。
import type { Map as MlMap } from 'maplibre-gl'

export const mapInstance: { current: MlMap | null } = { current: null }

/**
 * 图层是否已建立（地图 `load` 事件后为 true）。
 *
 * 为什么单独一个标志：`mapInstance.current` 在 `new Map()` 之后立刻有值，但那时
 * **样式与数据源还没建立**——此时调用 `MapDraw.set/add` 会把数据写进不存在的源而**静默丢失**。
 * 因此"能画图元"的判据是 `layersReady.current`，不是 `mapInstance.current`。
 */
export const layersReady: { current: boolean } = { current: false }
