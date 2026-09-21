// map-2d · **形状预览**（2026-09-21 新增）
//
// 用途（需求原话）："指定尺寸模式"的合并框里，中心点与尺寸**改一下就实时看到**；
// 而且**弹框那一刻就按默认值画出来**。宿主（mission-app 的态势屏）把"中心 + 尺寸"算成
// 一份形状规格推给这里，`DrawLayer` 用**与草稿同一套虚线青色预览图层**把它画出来。
//
// 为什么单独开一条通道，而不是复用 `core/draft.ts`：
//   · 草稿（点 / 线 / 面）是"**顶点图元**"的中间态，收笔后产生、确认时 `commit()` 成真图元；
//   · 本条要画的是**线状几何**（圆环 / 刻度圈 / 方格网）—— 它不是顶点图元，也没有"确认时提交"
//     这一步（确认由宿主自己按尺寸造 `annulus` 图元）。硬塞进草稿会把那条已经稳定的路搅浑。
//   两条通道**互不影响**：草稿一变仍走草稿；形状预览只在宿主设了值时才画。
//
// 语义（需求方定）：**确定前只算预览、不算正式图元** —— 不进 `MapDraw` 的图元集合，
//   因此不出现在图层面板、不参与导出；取消 / Esc 调 `clear()`，图上不留痕。
import { create } from 'zustand'
import type { LngLat } from './geometry'

/** 形状预览的四种几何（与"指定尺寸模式"的条目一一对应） */
export type ShapePreviewKind = 'ring' | 'bearing-ring' | 'grid' | 'rect'

export interface ShapePreview {
  /** 语义标识（宿主用条目 key；仅用于排障与去重，模块不解释它） */
  key: string
  kind: ShapePreviewKind
  /** 中心（经纬度） */
  center: LngLat
  /**
   * `rect`：半宽 / 半高（公里，东西向 / 南北向）。
   * 由宿主算成"半宽半高"给模块 —— 模块不懂业务上的"长/宽"，只按中心 + 半尺寸画个矩形环。
   */
  halfWkm?: number
  halfHkm?: number
  /** ring / bearing-ring：半径列表（公里）。ring 画多圈、bearing-ring 画圈 + 刻度 */
  radiusKmList?: number[]
  /** bearing-ring 的刻度间隔（度，默认 30） */
  bearingStepDeg?: number
  /** grid：每格边长（公里）与行列数 */
  sideKm?: number
  rows?: number
  cols?: number
}

interface ShapePreviewState {
  /** 当前形状预览（null = 没有） */
  preview: ShapePreview | null
  /** 设一份形状预览（同一份会就地替换 → 宿主改数字时图上直接跟着变） */
  show(p: ShapePreview): void
  /** 清掉（确定 / 取消都调它） */
  clear(): void
}

export const useShapePreview = create<ShapePreviewState>((set) => ({
  preview: null,
  show(p) { set({ preview: p }) },
  clear() { set({ preview: null }) },
}))

/** 非 React 场景（事件回调）读当前形状预览用 */
export const shapePreviewNow = (): ShapePreview | null => useShapePreview.getState().preview
