// map-2d · 多实例注册表（需求 M2-NFR-08 多实例隔离）
//
// 背景：模块早期是"单地图实例"设计——`mapInstance.current` 一个全局引用，
// 各处（绘制/网格/主题/降级/资源/诊断…）都从它取地图。全量改成"处处传实例"会触及
// 43 处引用、19 个文件，风险远大于收益。
//
// 本方案（精确注入）：
//   · 每个 `<MapView instanceId="xxx">` 把自己的地图登记进注册表，并成为**当前实例**；
//   · 未指定 instanceId 的仍用保留 id `'default'`，`mapInstance.current` 语义**完全不变**
//     ——因此现有全部调用点无需改动；
//   · 模块级子系统（绘制/网格/主题/降级…）作用在**当前实例**上。宿主若要在多个实例上
//     分别操作，先 `setActiveInstance(id)` 再调用即可（同步 API，语义明确）。
//
// ⚠️ 诚实边界（写在需求文档里，不夸大）：**图元集合、图层分组开关、主题、精度上限等
//   模块级状态当前是"当前实例共享"的**，不是每实例独立。真正每实例隔离需要把这些
//   子系统全部改成按 id 分表，属于下一步演进。本版保证的隔离是：
//   各自独立的样式/数据源/图层、独立相机与视口、独立控件、独立交互
//   （因为这些都是 MapLibre 实例自身的属性，天然隔离）。
import type { Map as MlMap } from 'maplibre-gl'
import { mapInstance } from './instance'

/** 默认实例 id（未显式指定 instanceId 的 MapView 用它） */
export const DEFAULT_INSTANCE_ID = 'default'

export interface MapInstanceInfo {
  id: string
  /** 是否当前实例（模块级操作作用在它上面） */
  isActive: boolean
  /** 是否已建立图层（load 完成） */
  ready: boolean
}

const registry = new Map<string, MlMap>()
let activeId: string = DEFAULT_INSTANCE_ID

/** 由 MapView 调用：登记/更新某 id 对应的地图，并把它设为当前实例 */
export function registerMapInstance(id: string, map: MlMap): void {
  registry.set(id, map)
  activeId = id
  mapInstance.current = map
}

/** 由 MapView 卸载时调用：注销；若注销的是当前实例，回落到另一个（没有则置空） */
export function unregisterMapInstance(id: string): void {
  registry.delete(id)
  if (activeId !== id) return
  const next = [...registry.keys()][0]
  if (next) {
    activeId = next
    mapInstance.current = registry.get(next) ?? null
  } else {
    activeId = DEFAULT_INSTANCE_ID
    mapInstance.current = null
  }
}

/** 全部已登记实例 */
export function listMapInstances(): MapInstanceInfo[] {
  return [...registry.entries()].map(([id, map]) => ({
    id,
    isActive: id === activeId,
    // 图层建好后样式里会有模块的业务源
    ready: !!map.getSource?.('src-area'),
  }))
}

/** 当前实例 id */
export function activeInstanceId(): string {
  return activeId
}

/** 切换"当前实例"：之后模块级操作（绘制/网格/主题等）作用在它上面 */
export function setActiveInstance(id: string): { ok: boolean; active: string; reason?: string } {
  const map = registry.get(id)
  if (!map) return { ok: false, active: activeId, reason: `未登记的实例：${id}（已登记：${[...registry.keys()].join(', ') || '无'}）` }
  activeId = id
  mapInstance.current = map
  return { ok: true, active: id }
}

/** 取某 id 的地图（不改变当前实例） */
export function getMapInstance(id: string): MlMap | null {
  return registry.get(id) ?? null
}

/** 实例数量（宿主可据此判断是否处于多实例场景） */
export function instanceCount(): number {
  return registry.size
}
