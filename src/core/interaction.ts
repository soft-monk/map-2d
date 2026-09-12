// map-2d · 绘制/编辑交互状态（需求 M2-DRAW-08 手绘 / M2-DRAW-12 编辑 / M2-CTRL-10 量算）
//
// 与"模块 UI 状态"（core/store.ts）分开：这里放的是**交互过程中的临时状态**
// （当前模式、已落顶点、测量结果、编辑目标），不参与持久化，也不该被宿主长期读取。
import { create } from 'zustand'
import type { LngLat } from './geometry'
import type { PrimitiveKind } from '../primitives/api'

/** 绘制模式：点 / 折线 / 面 / 测距 / 测面 / 关闭 */
export type DrawMode = 'none' | 'point' | 'line' | 'area' | 'measure-line' | 'measure-area'

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
  /** 吸附开关 */
  snapEnabled: boolean
  /** 光标处的吸附提示（有值表示当前会吸附到该点） */
  snapHint: { point: LngLat; label?: string } | null
  /** 交互提示文案（浮层展示） */
  hint: string

  setMode(mode: DrawMode): void
  setKind(kind: DrawKind): void
  addPoint(p: LngLat): void
  setPoints(pts: LngLat[]): void
  clearPoints(): void
  setMeasurement(m: Measurement | null): void
  startEdit(kind: PrimitiveKind, id: string): void
  setDragging(i: number | null): void
  endEdit(): void
  setSnapEnabled(on: boolean): void
  setSnapHint(h: { point: LngLat; label?: string } | null): void
  setHint(text: string): void
  /** 退出所有交互（Esc / 完成绘制后调用） */
  reset(): void
}

export const useInteraction = create<InteractionState>((set, get) => ({
  mode: 'none',
  points: [],
  kind: 'area',
  measurement: null,
  edit: null,
  snapEnabled: true,
  snapHint: null,
  hint: '',

  setMode(mode) {
    // 切换模式时清掉上一次绘制到一半的顶点（避免残留半成品）
    set({ mode, points: [], snapHint: null, edit: null, hint: '' })
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
  setSnapEnabled(on) { set({ snapEnabled: on, snapHint: on ? get().snapHint : null }) },
  setSnapHint(h) { set({ snapHint: h }) },
  setHint(text) { set({ hint: text }) },
  reset() { set({ mode: 'none', points: [], snapHint: null, edit: null, hint: '' }) },
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
