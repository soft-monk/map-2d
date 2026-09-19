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
 *
 * ★ 2026-09-18 起这些只是**缺省值**：宿主可以用 `configureControls()` 覆盖（见 `ControlSpec`）。
 *   需求方原话："修改 map2d 接口，要求不只是 true false，可以自己使用配置文件和哪些之前写的
 *   配置文件一起，**可配置显隐与位置**" —— 因为写死的位置在宿主版式里会被宿主自己的面板压住
 *   （实测：指北针落在右栏底下，开了也看不见）。
 */
const POSITION: Record<'zoom' | 'scale', ControlAnchor> = {
  zoom: 'top-right',
  scale: 'bottom-right',
}

/** 控件落位的四个锚点（与 MapLibre `addControl` 的 position 同一套命名） */
export type ControlAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * **一个控件的一份配置**（宿主可只给要改的字段）。
 *
 * - `on`：显隐（原接口只有这一维 true/false）
 * - `anchor`：落在哪个角（缺省 = 下面 POSITION 表 / 组件自带的角）
 * - `offset`：在锚点基础上的像素微调 `[dx, dy]`（正数向右 / 向下）
 */
export interface ControlSpec {
  key: MapControlKey
  on?: boolean
  anchor?: ControlAnchor
  offset?: [number, number]
}

/**
 * 自绘控件用：锚点 + 偏移 → 绝对定位的四条边。
 *
 * **语义（重要）**：`offset` 是"从锚点往**画面内侧**推"的像素量 ——
 * 四个角读起来是同一句话"离这个角多远"，配置里不必写负数：
 *   · `bottom-left` + `[0, 56]` → 距左边 12，距**底边** 12+56（即往上抬 56）
 *   · `top-right`   + `[8, 0]`  → 距顶边 12，距**右边** 12+8（即往左 8）
 * 原生控件（zoom / scale）走 MapLibre 的 position 字符串，**只认锚点、不认 offset**。
 */
export function anchorStyle(
  anchor: ControlAnchor | undefined,
  offset: [number, number] | undefined,
  gap = 12,
): Record<string, number> {
  const [dx, dy] = offset ?? [0, 0]
  const a: ControlAnchor = anchor ?? 'bottom-left'
  const s: Record<string, number> = {}
  if (a === 'top-left' || a === 'bottom-left') s.left = gap + dx
  else s.right = gap + dx
  if (a === 'top-left' || a === 'top-right') s.top = gap + dy
  else s.bottom = gap + dy
  return s
}

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
    const anchor = useMapUiStore.getState().controlLayout[key]?.anchor ?? POSITION[key]
    map.addControl(ensureNative(map, key), anchor)
    applyNativeOffset(map, key)
  } else if (!want && has) {
    const ctl = attached.get(map)?.[key]
    if (ctl) {
      try { map.removeControl(ctl) } catch { /* 已被移除 */ }
    }
  }
}

/**
 * 给**原生控件**（zoom / scale）补上 `offset`。
 *
 * MapLibre 的 `addControl` 只认四个角，**不支持像素偏移** —— 而"排成一列、距底 15px"这种
 * 版式要求必须有偏移。这里在挂上之后，找到它自己的 DOM 加一个 margin 实现同样的效果
 *（只动外边距，不动控件本身；找不到就静默跳过，不影响功能）。
 */
function applyNativeOffset(map: MlMap, key: 'zoom' | 'scale') {
  const layout = useMapUiStore.getState().controlLayout[key]
  const [dx, dy] = layout?.offset ?? [0, 0]
  const cls = key === 'zoom' ? '.maplibregl-ctrl-zoom' : '.maplibregl-ctrl-scale'
  const el = (map.getContainer() as HTMLElement).querySelector<HTMLElement>(cls)
  if (!el) return
  const a = layout?.anchor ?? POSITION[key]
  // ★ 2026-09-18（用户："经纬度与比例尺没有对齐"）：**左边缘必须与自绘控件同一个基准**。
  //   MapLibre 自带 `.maplibregl-ctrl` 有默认外边距（底左角是 margin-left 10px），而自绘控件用
  //   `left: 12` —— 差 2px，肉眼就是"没对齐"。所以这里把边距**显式写死成同一个 BASE**，不吃缺省值。
  const BASE = 12
  if (a === 'bottom-left' || a === 'top-left') el.style.marginLeft = `${BASE + Math.max(0, dx)}px`
  else el.style.marginRight = `${BASE + Math.max(0, dx)}px`
  if (a === 'bottom-left' || a === 'bottom-right') el.style.marginBottom = `${Math.max(0, dy)}px`
  else el.style.marginTop = `${Math.max(0, dy)}px`
  el.style.marginTop = a.startsWith('top') ? `${Math.max(0, dy)}px` : '0px'
  if (a.startsWith('bottom')) el.style.marginTop = '0px'
}

/**
 * **按配置设置控件**（2026-09-18 新增；宿主"可配置显隐与位置"的落点）。
 *
 * 与 `showControls` 的关系：后者只给 key 数组（等价于全部 `on=true`），
 * 本函数接受每个控件的 `{ on, anchor, offset }`，一次把**显隐 + 位置**都定下来。
 *
 * 例：
 * ```ts
 * mapCommands.configureControls([
 *   { key: 'coords', on: true, anchor: 'bottom-left', offset: [0, 56] },
 *   { key: 'scale',  on: true, anchor: 'bottom-right' },
 * ])
 * ```
 * 自绘控件（coords / compass / legend）只写状态，由 React 侧按 `controlLayout` 定位；
 * 原生控件（zoom / scale）在**首次挂载时**取锚点（MapLibre 不允许原地改位置，改位置要先摘再挂）。
 */
export function configureControls(map: MlMap | null, specs: ControlSpec[]) {
  const store = useMapUiStore.getState()
  const layout = { ...store.controlLayout }
  for (const s of specs) {
    if (s.anchor || s.offset) layout[s.key] = { anchor: s.anchor, offset: s.offset }
  }
  store.setControlLayout(layout)
  for (const s of specs) {
    if (s.on === undefined) continue
    const wasOn = useMapUiStore.getState().controls[s.key]
    if (s.on && wasOn && map && (s.key === 'zoom' || s.key === 'scale')) {
      // 已挂着又要改锚点：先摘再挂（MapLibre 不支持原地改位置）
      const ctl = attached.get(map)?.[s.key]
      if (ctl && s.anchor) {
        try { map.removeControl(ctl) } catch { /* 已被移除 */ }
        map.addControl(ensureNative(map, s.key), s.anchor)
        continue
      }
    }
    setControl(map, s.key, s.on)
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
