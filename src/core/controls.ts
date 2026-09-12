// map-2d · 地图控件按需显示（需求 M2-CTRL-01 ~ 05 / M2-API-05）
//
// 设计（见《设计文档》§10.1）：
//   · 控件**能力**由模块提供，**是否显示**默认全关（MAP_OPTIONS.controls）
//   · 需要时调 mapCommands.showControls(['compass','scale']) 打开，不调用就不出现
//   · 两种实现路径：
//       zoom / scale —— MapLibre 原生控件，用 addControl / removeControl 挂载与卸载
//       compass / coords —— 模块自绘组件，由模块 UI 状态（useMapUiStore.controls）控制渲染
//   · 地图样式重建（setStyle）不影响控件（控件挂在地图容器上，不在样式里）
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import { MAP_OPTIONS, ALL_CONTROL_KEYS, type MapControlKey } from './options'
import { useMapUiStore } from './store'

/** 原生控件实例缓存：重复 addControl 会报错，因此只挂载一次、之后只做增删 */
const attached = new WeakMap<MlMap, Partial<Record<'zoom' | 'scale', maplibregl.IControl>>>()

/**
 * 各控件在地图上的落位（避免互相遮挡 —— 这是踩过的坑）：
 *   · 缩放按钮 + 比例尺 —— **右下角成组**（缩放在上、比例尺在其下方）
 *   · 指北针            —— 右上角、缩放按钮正下方（见 Compass 的 top 偏移）
 *   · 鼠标位置经纬度     —— 左下角（见 CoordReadout）
 * 早期比例尺放在左下角，与经纬度读数**完全重叠**，因此把比例尺移到右下。
 */
const POSITION = {
  zoom: 'top-right',
  scale: 'bottom-right',
} as const

function ensureNative(map: MlMap, key: 'zoom' | 'scale') {
  let bag = attached.get(map)
  if (!bag) {
    bag = {}
    attached.set(map, bag)
  }
  if (!bag[key]) {
    bag[key] =
      key === 'zoom'
        ? new maplibregl.NavigationControl({ showCompass: false })
        : new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' })
  }
  return bag[key] as maplibregl.IControl
}

function isAttached(map: MlMap, key: 'zoom' | 'scale') {
  return !!attached.get(map)?.[key]
}

/**
 * 把某个控件设为显示/隐藏。
 * 自绘控件（compass / coords）只改状态，由 React 侧渲染。
 */
export function setControl(map: MlMap | null, key: MapControlKey, on: boolean) {
  const store = useMapUiStore.getState()
  const visible = { ...store.controls, [key]: on }
  store.setControls(visible)

  if (!map || (key !== 'zoom' && key !== 'scale')) return
  const want = on
  const has = isAttached(map, key)

  if (want && !has) {
    map.addControl(ensureNative(map, key), POSITION[key])
  } else if (!want && has) {
    const ctl = attached.get(map)?.[key]
    if (ctl) {
      try { map.removeControl(ctl) } catch { /* 已被移除 */ }
    }
  }
}

/** 批量设置：传入要开启的控件清单（不在清单里的保持不变）；第二参给 false 表示关闭清单里的控件 */
export function showControls(map: MlMap | null, keys: MapControlKey[], on = true) {
  for (const k of keys) setControl(map, k, on)
}

/** 切换单个控件 */
export function toggleControl(map: MlMap | null, key: MapControlKey) {
  setControl(map, key, !useMapUiStore.getState().controls[key])
}

/** 当前显示的控件清单 */
export function visibleControls(): MapControlKey[] {
  const c = useMapUiStore.getState().controls
  return ALL_CONTROL_KEYS.filter((k) => c[k])
}

/** 读取控件开关状态 */
export function controlState(): Record<MapControlKey, boolean> {
  return { ...useMapUiStore.getState().controls }
}

/**
 * 按状态恢复控件（地图创建后调用一次）：
 * 把 MAP_OPTIONS.controls 作为初始值写入状态，并挂载其中为 true 的原生控件。
 */
export function applyControls(map: MlMap) {
  const initial = { ...MAP_OPTIONS.controls }
  useMapUiStore.getState().setControls(initial)
  for (const key of ALL_CONTROL_KEYS) {
    if (initial[key]) setControl(map, key, true)
  }
}
