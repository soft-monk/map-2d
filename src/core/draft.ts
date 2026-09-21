// map-2d · **几何草稿**（2026-09-21 新增；需求："点 / 线 / 面绘制完成后弹合并框，确认后才定死"）
//
// 为什么要有这一层（这是本轮唯一的新概念，看懂它就够）：
//   改造前，绘制**收笔那一刻就把图元写进 `MapDraw`**（`DrawLayer` 的 `finishGeo` / `finishDraw`）。
//   宿主随后弹的编辑框，改的是**已经落图**的图元 —— 用户想"先画出来看、确认了才算数"就做不到。
//
//   现在把"落点 → 定死"切成两段：
//     ① 收笔 / 落点 → 只产生一份**草稿**（本文件），图上画的是**预览**（`useInteraction.preview`），
//        `MapDraw` 里**什么都没有**；
//     ② 宿主在框里改标签 / 改经纬度 / 加行 / 删行，全部改的是这份草稿 → 预览实时跟着变；
//     ③ 【确定】`commit()` 才写进 `MapDraw`；【取消】/ Esc `discard()` 直接扔掉草稿 —— **图上不留痕**。
//
// 为什么放在模块里而不是宿主里：① 预览要跟绘制预览共用一套图层（`DrawLayer` 的 preview）；
//   ② "点 / 线 / 面各要几个顶点、最少几个"是几何规则，属于绘制能力（与 `PRIMITIVE_CATALOG` 同源）。
//   宿主只读它、改它、提交它 —— 不自己写几何。
//
// 与 `useInteraction` 的关系：`hintMode`（提示态）由本模块在起绘时置上，
//   草稿存在 / 不存在与它是并列的两件事，互不依赖。
import { create } from 'zustand'
import type { GeometryKey } from './interaction'
import type { LngLat } from './geometry'
import { insertVertex, removeVertex } from './geometry'

/** 草稿的几何种类（就是 `GeometryKey`；单列一个别名，读起来明确"这是草稿"） */
export type DraftKind = GeometryKey

/** 草稿的一条顶点（经纬度数字；合法性由宿主输入层保证） */
export type DraftVertex = LngLat

/** 一份几何草稿：**还没写进 `MapDraw`** 的点 / 线 / 面 */
export interface GeometryDraft {
  kind: DraftKind
  /** 顶点；点 = 1 个，线 ≥ 2，面 / 闭合线 ≥ 3 */
  points: LngLat[]
  /** 图上默认文本（之后用 `bindTextTo` 挂上去） */
  label: string
  /** 文本样式（2026-09-21 起宿主不再提供切换，固定 `'tag'`） */
  textStyle: 'tag' | 'card' | 'callout'
  /** 外观（照抄 `setGeometry` 的入参；本模块不解释它们的业务含义） */
  color?: string
  widthPx?: number
  sizePx?: number
  dashed?: boolean
  fillColor?: string
  fillOpacity?: number
  /**
   * **宿主自定义建法**（`GeometryRequest.make` 原样带过来）。
   *
   * 有它的时候，`commit()` **不**按 `kind` 画几何原语，而是把顶点交给它（业务层的
   * 军标 / 距离环 / 目标点就走这条路）。返回 null = 没造出来。
   */
  make?: (pts: { lng: number; lat: number }[], radiusKm: number) => string | null
}

/** 顶点数下限（`point` 只有 1 个顶点，不存在"下限"一说） */
export function minVerticesOf(kind: DraftKind): number {
  if (kind === 'point') return 1
  if (kind === 'line') return 2
  return 3   // closedLine / polygon
}

/** 该种类的顶点能不能增删（**点不能** —— 需求："点没有加删按钮"） */
export function draftCanEditRows(kind: DraftKind): boolean {
  return kind !== 'point'
}

/** 顶点数的当前问题（返回 null = 合法）；宿主用它决定"确认时拦不拦"与提示什么 */
export function draftVertexError(d: GeometryDraft): string | null {
  const min = minVerticesOf(d.kind)
  if (d.points.length >= min) return null
  const name = d.kind === 'line' ? '线' : d.kind === 'closedLine' ? '闭合线' : '面'
  return `${name}至少 ${min} 个顶点（现在 ${d.points.length} 个）`
}

/** 起绘时的一份草稿要带哪些字段（从 `GeometryRequest` 抄） */
export interface DraftInit {
  kind: DraftKind
  points: LngLat[]
  label: string
  textStyle: 'tag' | 'card' | 'callout'
  color?: string
  widthPx?: number
  sizePx?: number
  dashed?: boolean
  fillColor?: string
  fillOpacity?: number
  make?: (pts: { lng: number; lat: number }[], radiusKm: number) => string | null
}

interface DraftState {
  /** 当前草稿（null = 没在画） */
  draft: GeometryDraft | null
  /** 起一份草稿（只由模块内部的绘制收笔调用） */
  begin(init: DraftInit): void
  /** 改标签（框里输入即调） */
  setLabel(text: string): void
  /** 改样式（2026-09-21 起宿主不再切换，留着是为了不把模块能力锁死） */
  setTextStyle(style: 'tag' | 'card' | 'callout'): void
  /** 整体换顶点（框里改数字 / 地图上拖手柄都走它） */
  setPoints(pts: LngLat[]): void
  /** 改某一个顶点 */
  setPoint(index: number, p: LngLat): void
  /**
   * 加一行：**默认坐标 = 复制最后一个顶点**（2026-09-21 需求方定），**追加到末尾**。
   * @returns 新行的下标（宿主用来把焦点挪过去）；点类返回 -1（点不能加行）
   */
  addRow(): number
  /**
   * 删一行。**到下限就不动**（需求："删到下限时不允许继续删"）。
   * @returns 是否真的删掉了
   */
  removeRow(index: number): boolean
  /** 放弃草稿（取消 / Esc）：图上不留痕 */
  discard(): void
  /** 提交草稿 → 写进 `MapDraw`；成功后草稿清空。返回新图元 id（失败返回 null） */
  commit(): string | null
}

// ---- 提交用的落库函数由 `primitives/draw-api` 注入 ----
//
// 为什么用注入而不是直接 import：`draw-api` 依赖 `interaction`（预览状态），本文件也依赖 `interaction`，
// 直接相互 import 会绕成环。这里留一个**单向**的注册口：模块启动时 `draw-api` 把实现塞进来。
export interface DraftCommitter {
  /** 按草稿画几何原语（点 / 线 / 闭合线 / 面），返回 id */
  draw(d: GeometryDraft): string | null
}

let committer: DraftCommitter | null = null

/** 供 `primitives/draw-api` 在模块加载时注册（宿主不要调用） */
export function registerDraftCommitter(c: DraftCommitter): void {
  committer = c
}

export const useGeometryDraft = create<DraftState>((set, get) => ({
  draft: null,

  begin(init) {
    set({
      draft: {
        kind: init.kind,
        points: init.points.map((p) => [p[0], p[1]] as LngLat),
        label: init.label,
        textStyle: init.textStyle,
        color: init.color,
        widthPx: init.widthPx,
        sizePx: init.sizePx,
        dashed: init.dashed,
        fillColor: init.fillColor,
        fillOpacity: init.fillOpacity,
        make: init.make,
      },
    })
  },

  setLabel(text) {
    const d = get().draft
    if (d) set({ draft: { ...d, label: text } })
  },
  setTextStyle(style) {
    const d = get().draft
    if (d) set({ draft: { ...d, textStyle: style } })
  },
  setPoints(pts) {
    const d = get().draft
    if (d) set({ draft: { ...d, points: pts.map((p) => [p[0], p[1]] as LngLat) } })
  },
  setPoint(index, p) {
    const d = get().draft
    if (!d || index < 0 || index >= d.points.length) return
    const pts = d.points.map((q, i) => (i === index ? ([p[0], p[1]] as LngLat) : q))
    set({ draft: { ...d, points: pts } })
  },
  addRow() {
    const d = get().draft
    if (!d || !draftCanEditRows(d.kind)) return -1
    const last = d.points[d.points.length - 1] ?? [0, 0]
    // 追加到末尾；默认坐标 = 复制最后一个顶点（需求方定）
    const pts = [...d.points, [last[0], last[1]] as LngLat]
    set({ draft: { ...d, points: pts } })
    return pts.length - 1
  },
  removeRow(index) {
    const d = get().draft
    if (!d || !draftCanEditRows(d.kind)) return false
    const min = minVerticesOf(d.kind)
    if (d.points.length <= min) return false          // 到下限不允许继续删
    if (index < 0 || index >= d.points.length) return false
    set({ draft: { ...d, points: removeVertex(d.points, index, min) } })
    return true
  },
  discard() {
    set({ draft: null })
  },
  commit() {
    const d = get().draft
    if (!d) return null
    if (draftVertexError(d)) return null               // 顶点不够：不提交（宿主会拦住并提示）
    if (!committer) return null
    const id = committer.draw(d)
    if (!id) return null
    set({ draft: null })
    return id
  },
}))

/** 非 React 场景（事件回调）读草稿用 */
export const draftNow = (): GeometryDraft | null => useGeometryDraft.getState().draft

/**
 * 按"某个顶点被移动了"更新草稿（地图上拖手柄时用）。
 * 重复点会被忽略 —— 拖拽过程中会高频调用，没必要每次都写。
 */
export function moveDraftVertex(index: number, p: LngLat): void {
  const d = draftNow()
  if (!d) return
  const cur = d.points[index]
  if (cur && cur[0] === p[0] && cur[1] === p[1]) return
  useGeometryDraft.getState().setPoint(index, p)
}

/** 在指定段之后插入一个顶点（目前只给"加行"用；保留段语义给将来的"线上插点"） */
export function insertDraftVertex(segIndex: number, p: LngLat): void {
  const d = draftNow()
  if (!d || !draftCanEditRows(d.kind)) return
  useGeometryDraft.getState().setPoints(insertVertex(d.points, segIndex, p))
}
