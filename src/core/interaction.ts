// map-2d · 绘制/编辑交互状态（需求 M2-DRAW-08 手绘 / M2-DRAW-12 编辑 / M2-CTRL-10 量算）
//
// 与"模块 UI 状态"（core/store.ts）分开：这里放的是**交互过程中的临时状态**
// （当前模式、已落顶点、测量结果、编辑目标），不参与持久化，也不该被宿主长期读取。
import { create } from 'zustand'
import type { LngLat } from './geometry'
import type { PrimitiveKind } from '../primitives/api'

/** 绘制模式：点 / 折线 / 面 / 测距 / 测面 / 关闭 */
export type DrawMode = 'none' | 'point' | 'line' | 'area' | 'measure-line' | 'measure-area'

/**
 * **几何原语**（2026-09-18 新增；用户第 2 条 + 第 3 条）。
 *
 * 与 `DrawMode` 的关系：`DrawMode` 是"模块内部怎么画"的老枚举（落到 area/label/route/track 四类）；
 * `GeometryKey` 是**面向几何的对外概念**（点 / 线 / 闭合线 / 真面 / 圆 / 椭圆），
 * 交互语义由 `PRIMITIVE_CATALOG` 声明（`click` / `two-point` / `polyline` / `polygon`）。
 *
 * 有了它，宿主不必再自己写"第一下点圆心、第二下点半径"的状态机 —— 那是绘制能力，属于模块。
 */
export type GeometryKey = 'point' | 'line' | 'closedLine' | 'polygon' | 'circle' | 'ellipse'

/** 启动一次几何原语绘制的入参（外观都从函数入参来，不吃配置文件） */
export interface GeometryRequest {
  key: GeometryKey
  color?: string
  widthPx?: number
  sizePx?: number
  dashed?: boolean
  fillColor?: string
  fillOpacity?: number
  /** 画完自动挂的文本（不给就不挂） */
  text?: string
  textStyle?: 'tag' | 'card' | 'callout'
  /** 画完的回调（宿主用来选中/提示） */
  onDone?: (id: string) => void
  /**
   * **宿主自定义"落点 → 图元"的建法**（2026-09-18 业务层改造时加的钩子）。
   *
   * 为什么不直接让宿主自己处理点击：**交互过程（落点、两下算尺寸、多点收笔、预览、Esc/Enter）
   * 属于绘制能力，应该留在模块里**；而"落下的这个点代表什么业务图元"属于业务语义，应该在宿主。
   * 这个钩子就是那条分界线：模块负责"怎么点"，`make` 负责"点完造出什么"。
   *
   * 传了它，模块就**不再**按 `key` 画自己的几何原语，改为把落点交给 `make`：
   * @param pts      已落下的点（`click`/`two-point` 给 1~2 个；`polyline`/`polygon` 给全部）
   * @param radiusKm `two-point` 类由两点算出的半径（公里）；其余为 0
   * @returns 造出来的图元 id（宿主自己 `MapDraw.add`）；返回 null 表示没造出来
   */
  make?: (pts: { lng: number; lat: number }[], radiusKm: number) => string | null
}

/** 绘制/编辑完成后的落库目标类型（决定 MapDraw 往哪一类写） */
export type DrawKind = Extract<PrimitiveKind, 'area' | 'label' | 'route' | 'track'>

export interface Measurement {
  mode: 'line' | 'area'
  points: LngLat[]
  /** 折线长度（米）/ 面积（m²） */
  meters?: number
  areaM2?: number
  /** 起点→终点方位角（度） */
  bearing?: number
}

export interface EditTarget {
  kind: PrimitiveKind
  id: string
  /** 正在拖拽的顶点下标（未拖拽为 null） */
  dragging: number | null
}

interface InteractionState {
  mode: DrawMode
  /** 已落下的顶点（未完成绘制时） */
  points: LngLat[]
  /** 绘制结果写入哪一类图元 */
  kind: DrawKind
  /** 最近一次量算结果 */
  measurement: Measurement | null
  /** 编辑中的图元 */
  edit: EditTarget | null
  /** 交互提示文案（浮层展示） */
  hint: string
  /**
   * **正在绘制的几何原语**（2026-09-18 新增；null = 没在画几何原语）。
   *
   * 有值时，落点语义由 `PRIMITIVE_CATALOG[key].interaction` 决定：
   * `click` 一下即成、`two-point` 两下、`polyline`/`polygon` 多点。**模块自己完成绘制**，
   * 宿主只负责 `setGeometry(...)` 起、看 `onDone` 收。
   */
  geo: GeometryRequest | null

  setMode(mode: DrawMode): void
  setKind(kind: DrawKind): void
  addPoint(p: LngLat): void
  setPoints(pts: LngLat[]): void
  clearPoints(): void
  setMeasurement(m: Measurement | null): void
  startEdit(kind: PrimitiveKind, id: string): void
  setDragging(i: number | null): void
  endEdit(): void
  setHint(text: string): void
  /** 开始一次几何原语绘制（传 null 取消） */
  setGeometry(req: GeometryRequest | null): void
  /** 退出所有交互（Esc / 完成绘制后调用） */
  reset(): void
}

export const useInteraction = create<InteractionState>((set, get) => ({
  mode: 'none',
  points: [],
  kind: 'area',
  measurement: null,
  edit: null,
  hint: '',
  geo: null,

  setGeometry(req) {
    // 起一个新的几何绘制 = 清掉上一次的半成品；同时把老的 `mode` 关掉，避免两套交互打架
    set({ geo: req, mode: 'none', points: [], measurement: null, edit: null, hint: '' })
  },

  setMode(mode) {
    // 切换模式时清掉上一次绘制到一半的顶点（避免残留半成品）
    set({ mode, points: [], edit: null, hint: '' })
  },
  setKind(kind) { set({ kind }) },
  addPoint(p) { set({ points: [...get().points, p] }) },
  setPoints(pts) { set({ points: pts }) },
  clearPoints() { set({ points: [] }) },
  setMeasurement(m) { set({ measurement: m }) },
  startEdit(kind, id) { set({ edit: { kind, id, dragging: null }, mode: 'none', points: [] }) },
  setDragging(i) {
    const e = get().edit
    if (e) set({ edit: { ...e, dragging: i } })
  },
  endEdit() { set({ edit: null }) },
  setHint(text) { set({ hint: text }) },
  reset() { set({ mode: 'none', points: [], edit: null, hint: '' }) },
}))

/** 当前模式是否处于"点击落点"的绘制态 */
export function isDrawing(mode: DrawMode): boolean {
  return mode === 'point' || mode === 'line' || mode === 'area' || mode === 'measure-line' || mode === 'measure-area'
}

/** 各模式的默认落库类型（点=标注、线=航线、面=区域） */
export const DEFAULT_KIND: Record<Exclude<DrawMode, 'none'>, DrawKind> = {
  point: 'label',
  line: 'route',
  area: 'area',
  'measure-line': 'track',
  'measure-area': 'area',
}