// 地图模块 · 模块级可调项
//
// ⚠️ 合规提醒：`showAttribution` 控制底图版权署名（地图右下角）。
//    Esri World Imagery 的使用条款通常要求保留署名
//    （Esri, Maxar, Earthstar Geographics, and the GIS User Community）。
//    设为 false 只是让界面更整洁，**合规责任由使用方承担**；
//    需要恢复署名时把下面这一项改回 true 即可（无需改动其它任何文件）。
/**
 * 默认瓦片模板（模块级约定）。
 * 宿主不配置 	ileUrlTemplate 时按此取瓦片；瓦片包校验（M2-BASE-08）也以它作为参考模板。
 */
export const DEFAULT_TILE_TEMPLATE = '/tiles/raster/{z}/{x}/{y}.jpg'

export const MAP_OPTIONS = {
  /** 是否在地图右下角显示底图版权署名 */
  showAttribution: false,

  /** 显示署名时的紧凑模式（鼠标悬停展开完整署名） */
  compactAttribution: true,

  /**
   * 栅格瓦片淡入时长（毫秒）。
   * 0 = 关闭淡入：瓦片下载完成即刻显示，拖动时"低清叠底 → 高清"的替换是瞬时的，
   * 不会在中途露出底色（黑框）。需要老版本的柔和淡入效果时改回 300 即可。
   */
  rasterFadeDuration: 0,

  /**
   * 地图控件是否显示（需求 M2-CTRL-01 ~ 05）。
   * 四项**默认全部不显示**：控件能力具备，但不由模块自动挂上地图——
   * 需要时用 `mapCommands.showControls(['compass','scale'])` 按需开启。
   * 也可以直接改这里的默认值，让某类控件开箱即显示。
   */
  controls: {
    /** 指北针（随方向旋转，点击复位正北） */
    compass: false,
    /** 鼠标位置经纬度（随光标刷新） */
    coords: false,
    /** 缩放按钮 + / − */
    zoom: false,
    /** 比例尺（公制） */
    scale: false,
    /** 地图内图例（M2-CTRL-11） */
    legend: false,
  },

  /**
   * 瓦片精度上限（需求 M2-BASE-05 / 决策 D2：**默认不限制**）。
   * 单位：米/像素，null 表示不限制；也可以用 `mapCommands.setTilePrecisionLimit()` 运行时设置。
   * 只作用于本地栅格底图（在线样式底图不受约束，决策 D4）。
   */
  tileMaxMetersPerPixel: null as number | null,
}

export type MapOptions = typeof MAP_OPTIONS

/** 可开关的地图控件标识（M2-CTRL-01） */
export type MapControlKey = keyof typeof MAP_OPTIONS.controls

export const ALL_CONTROL_KEYS = ['compass', 'coords', 'zoom', 'scale', 'legend'] as const satisfies readonly MapControlKey[]

/** 米/像素 → 缩放层级（Web Mercator，取赤道值，偏保守）；用于瓦片精度上限换算 */
export function metersPerPixelToZoom(mpp: number): number {
  return Math.log2(156543.03392 / Math.max(0.01, mpp))
}

/** 缩放层级 → 米/像素（赤道值） */
export function zoomToMetersPerPixel(z: number): number {
  return 156543.03392 / Math.pow(2, z)
}
