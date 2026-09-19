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
  /**
   * **汉字/假名/韩文是否交给浏览器本机字体实时生成 SDF**（2026-09-18 二次修订：**默认关闭**）。
   *
   * 这条的来龙去脉值得写清楚，因为它是"文字能不能一行画完"的关键：
   *
   * ① 打开它（给一个 CSS 字体族串）时：MapLibre 的 `_doesCharSupportLocalGlyph`
   *    对**所有**表意文字返回真，于是汉字**一律**走 `TinySDF` 在客户端生成，
   *    **`glyphsUrl` 里的汉字字形根本不会被使用**（源码：`_doesCharSupportLocalGlyph(id) || (glyphs[id] = pbfGlyphs[id])`）。
   * ② 问题在于：一段文字里如果**同时**有汉字（本机生成）和拉丁/数字（PBF），
   *    渲染器会把这两条来源的字**分别排版** —— 实测「光电 opt-005」被拆成"光电"一块、
   *    `opt-005` 另一块（`text-max-width`、`text-allow-overlap` 怎么调都一样）。
   * ③ 所以本工程改为：**汉字也由离线字形 PBF 提供**（`scripts/gen-glyphs.cs` 按常用字白名单生成，
   *    见 `apps/web/public/fonts/MapApp/`），并把这一项**关掉** —— 一段文字只有一个字形来源，一行到底。
   *
   * 代价：**名单外的生僻字没有字形、不会显示**。名单范围由宿主决定（本应用 = 键盘字符 + GB2312
   * 一级常用字 3755 个 + 应用源码里出现的字，合计约 3.6 MB）。
   * 若要恢复"本机实时生成、任意汉字都能显示"，把下面这行改回一个字体族串即可（代价见 ②）。
   */
  localIdeographFontFamily: '',

  /**
   * **字形 PBF 的地址**（`{fontstack}` / `{range}` 由 MapLibre 填）。
   *
   * 本工程用的是**离线自造**的字形：`map-2d/scripts/gen-glyphs.cs` 把本机字体栅格化成 SDF，
   * 只生成非表意字符的四段（0 / 8192 / 12288 / 65280），实测 577 KB。
   * 文件放在宿主能托管的位置（本应用是 `apps/web/public/fonts/MapApp/`，由现有静态路由托管）。
   */
  glyphsUrl: '/fonts/{fontstack}/{range}.pbf',

  /**
   * **图片图集（sprite）地址** —— 2026-09-18 新增，用来给文本框画**底色块**。
   *
   * MapLibre 的 `symbol` 图层只有 `text-halo`（描边），**没有文字底色**。要真正的"文本框"，
   * 标准做法是：sprite 里放一张小图，图层上写 `icon-image` + `icon-text-fit: 'both'`，
   * 渲染器就把它拉伸到与文字同宽同高垫在下面（`content` 字段保证圆角/边框不被拉伸）。
   *
   * MapLibre 会按 `{spriteUrl}.json` / `{spriteUrl}.png`（高分屏 `@2x`）去取，所以这里**不带扩展名**。
   * 本工程的图由 `map-2d/scripts/gen-sprite.ps1` 离线生成，含三张：
   * `textbox-tag` / `textbox-card` / `textbox-callout`（对应 `TEXT_STYLES` 的三种样式）。
   */
  spriteUrl: '/sprites/mapapp',

  /**
   * **文字用的字体栈**（MapLibre 的 `text-font`）—— 2026-09-18 新增。
   *
   * 为什么必须有这一项：MapLibre 的 `text-font` 缺省值是
   * `["Open Sans Regular","Arial Unicode MS Regular"]`，它会去 `glyphsUrl` 下按这个**名字**取 PBF。
   * 本工程的字形是自己按**目录名**托管的（`/fonts/MapApp/…`），名字对不上就是 404，
   * 结果是**一个字都画不出来**（不是画得难看，是整层文字消失）。
   *
   * 所以：这里的名字必须与字形托管目录**同名**（本工程是 `MapApp`，见 `apps/web/public/fonts/MapApp/`）。
   * 数组里的名字会被 `{fontstack}` 用逗号拼起来，多字体回落可以写多项。
   */
  textFont: ['MapApp'],

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
