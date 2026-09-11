// 地图模块 · 模块级可调项
//
// ⚠️ 合规提醒：`showAttribution` 控制底图版权署名（地图右下角）。
//    Esri World Imagery 的使用条款通常要求保留署名
//    （Esri, Maxar, Earthstar Geographics, and the GIS User Community）。
//    设为 false 只是让界面更整洁，**合规责任由使用方承担**；
//    需要恢复署名时把下面这一项改回 true 即可（无需改动其它任何文件）。
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
   * 全球低精度"地板层"预热到的最大层级（见 core/preload.ts）。
   * 4 = z0–4 共 341 张 / 约 2.7 MB（局域网实测预热 ≈ 0.2–0.3 s）。
   * 这是性价比拐点：z0–4 覆盖"缩小后拖拽"的全部场景；再加一层体积 ×4、收益却很小。
   * 设为 0 表示不预热；设为 -1 表示由宿主自行决定（不读取本项）。
   */
  preloadMaxZoom: 4,

  /** 预热的并发数（8 已接近局域网服务端吞吐上限，再大单张反而变慢） */
  preloadConcurrency: 8,
}

export type MapOptions = typeof MAP_OPTIONS
