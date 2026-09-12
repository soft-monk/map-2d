// map-2d · 瓦片精度上限（需求 M2-BASE-05 / 决策 D1 ~ D4）
//
// 语义（见《设计文档》§10.4）：
//   · 以**地面分辨率（米/像素）**为入口，内部换算成"允许使用的最大层级"
//   · **硬边界**：超过上限的层级不再请求瓦片，由 MapLibre 用较粗瓦片放大显示（overzoom）
//   · **默认不限制**（MAP_OPTIONS.tileMaxMetersPerPixel = null）
//   · 只作用于**本地栅格底图**；在线样式底图（styleUrl）不受约束
import { MAP_OPTIONS, metersPerPixelToZoom } from './options'
import { mapInstance } from './instance'

/** 本地栅格底图允许的最大层级（瓦片数据的实际上限） */
export const TILE_DATA_MAX_ZOOM = 14

/** 当前生效的瓦片最大层级：未设上限时为 TILE_DATA_MAX_ZOOM */
export function tileMaxZoomFromOptions(): number {
  const mpp = MAP_OPTIONS.tileMaxMetersPerPixel
  if (mpp == null || !Number.isFinite(mpp) || mpp <= 0) return TILE_DATA_MAX_ZOOM
  return Math.max(1, Math.min(TILE_DATA_MAX_ZOOM, Math.floor(metersPerPixelToZoom(mpp))))
}

/**
 * 让新的精度上限生效。
 *
 * 实现方式：改完 MAP_OPTIONS 后触发一次样式重建（栅格源的 maxzoom 写在样式里）。
 * 重建会清空 source/layer，因此这里只负责"发起重建"，重建后的图层恢复与
 * 图元重放由 MapView 的样式切换流程统一处理（与换底图同一条路径）。
 * 地图尚未创建时只改配置，下次建图自然生效。
 */
export function applyTilePrecision(): number {
  const map = mapInstance.current
  if (!map) return tileMaxZoomFromOptions()

  // 触发 React 侧的重建：用一次自定义事件，避免在这里反向 import UI 组件
  window.dispatchEvent(new CustomEvent('map2d:tile-precision-change'))
  return tileMaxZoomFromOptions()
}
