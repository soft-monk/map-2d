// map-2d · 模块内控件样式（自行注入，不依赖宿主样式表）
//
// 为什么要有这个文件：
//   地图控件的观感（比例尺/缩放按钮的深色底、可读字号）属于**模块职责**。
//   早期这些样式只写在独立宿主的 standalone.css 里，导致主系统嵌入时比例尺是
//   MapLibre 默认样式（又小又淡，在暗色影像上几乎看不见，甚至被误认为"没显示"）。
//   现在由模块在 MapView 初始化时注入一份，任何宿主都能得到一致的观感。
import { MAP_OPTIONS } from './options'

const STYLE_ID = 'map-2d-control-style'

const CSS = `
/* 比例尺：加底色、内边距与字号，保证在任何底图上都看得清 */
.map2d-map .maplibregl-ctrl-scale {
  background: rgba(8, 16, 30, 0.78);
  border: 1px solid var(--panel-border, #1d3a5c);
  border-top: none;
  border-radius: 0 0 4px 4px;
  color: var(--text-1, #cfe3f5);
  font-family: Consolas, "Microsoft YaHei", monospace;
  font-size: 11.5px;
  line-height: 1.4;
  padding: 2px 8px 3px;
  backdrop-filter: blur(6px);
}
/* 缩放按钮组：与模块其它浮层同一套配色 */
.map2d-map .maplibregl-ctrl-group {
  background: rgba(8, 16, 30, 0.78);
  border: 1px solid var(--panel-border, #1d3a5c);
  backdrop-filter: blur(6px);
}
.map2d-map .maplibregl-ctrl-group button + button {
  border-top: 1px solid var(--panel-border, #1d3a5c);
}
.map2d-map .maplibregl-ctrl-group button span {
  filter: invert(1) hue-rotate(180deg);
}
/* 署名（MAP_OPTIONS.showAttribution 打开时出现）也一并深色化 */
.map2d-map .maplibregl-ctrl-attrib {
  background: rgba(8, 16, 30, 0.7);
  color: var(--text-2, #8fb0cc);
  font-size: 10.5px;
}
.map2d-map .maplibregl-ctrl-attrib a { color: var(--text-2, #8fb0cc); }
`

/** 把模块控件样式注入文档（幂等，只注一次） */
export function injectControlStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = CSS
  document.head.appendChild(el)
}

/**
 * 给地图容器加模块标记类：模块样式只作用于 `.map2d-map` 之内，
 * 不影响宿主自己的 MapLibre 实例或其它控件。
 */
export const MAP_CONTAINER_CLASS = 'map2d-map'

/** 是否显示署名（影响容器是否需要给署名留位置，当前仅作记录） */
export const attributionEnabled = () => MAP_OPTIONS.showAttribution
