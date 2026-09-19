// mission-app · map-2d · src/primitives/catalog.ts
//
// **图元种类自描述清单** —— 用户第 2 条要"绘制功能都是可调用的函数接口"，
// 那么"到底能画什么、每种要哪些参数、怎么交互"就该由**模块自己说出来**，
// 而不是让宿主手抄一份菜单（mission-app 的 `draw-catalog.ts` 原来就是手抄的 25 项，
// 模块加一种图元宿主就得改一次代码 —— 耦合点就在这）。
//
// 本文件是**纯数据描述**：不渲染、不副作用。宿主的绘制菜单、参数面板、帮助文案都可以由它生成。
import type { TextStyle } from './draw-api'

/** 一个入参的描述 */
export interface ParamDef {
  name: string
  /** 中文名（菜单/表单直接用） */
  label: string
  type: 'number' | 'string' | 'boolean' | 'lnglat' | 'points' | 'ring'
  /** 单位（`km` / `px` / `°`…），没有就不显示 */
  unit?: string
  /** 缺省值（不给表示必填） */
  default?: number | string | boolean
  min?: number
  max?: number
  /** 一句话说明 */
  note?: string
}

/** 一种几何原语 */
export interface GeometryDef {
  key: 'point' | 'line' | 'closedLine' | 'polygon' | 'circle' | 'ellipse'
  /** 中文名 */
  name: string
  /** 几何归类（宿主按它分组菜单） */
  geometry: '点' | '线' | '面'
  /**
   * 交互方式（宿主据此决定"点一下/点两下/连点"）：
   * · `click`      —— 落点即建
   * · `two-point`  —— 两下：第一下定中心/起点，第二下定尺寸/终点
   * · `polyline`   —— 多点连线，双击/Enter 结束
   * · `polygon`    —— 多点围合，双击/Enter 结束
   */
  interaction: 'click' | 'two-point' | 'polyline' | 'polygon'
  params: ParamDef[]
  /** 缺省样式（宿主菜单里可以直接照抄做预览） */
  defaults: { color: string; widthPx?: number; sizePx?: number; dashed?: boolean }
}

/** 文本框的几种样式（用户第 3 条："可以绑定几种文本框的方式"） */
export const TEXT_STYLES: { key: TextStyle; name: string; note: string }[] = [
  { key: 'tag', name: '角标', note: '一行小字贴着图元，底色 + 细边；最省地方，适合"就叫这个名字"' },
  { key: 'card', name: '卡片', note: '标题 + 多行正文；适合"名称 + 参数"，信息量大' },
  { key: 'callout', name: '引线标注', note: '一根引线指向图元、文字浮在旁边；不压住图形，适合密集场景' },
]

/**
 * **能画什么**（六个几何原语，覆盖"点 / 线 / 闭合线 / 真面 / 圆 / 椭圆"）。
 *
 * 业务化的图元种类（target / scan / pulse / symbol / annulus / cluster …）**不在这里**：
 * 它们是"几何 + 预设样式"的组合，仍可用底层 `MapDraw.set/add(kind, item)` 画。
 */
export const PRIMITIVE_CATALOG: GeometryDef[] = [
  {
    key: 'point', name: '点', geometry: '点', interaction: 'click',
    params: [
      { name: 'lng', label: '经度', type: 'lnglat' },
      { name: 'lat', label: '纬度', type: 'lnglat' },
      { name: 'sizePx', label: '大小', type: 'number', unit: 'px', default: 4, min: 1, max: 40, note: '点的半径（像素）' },
      { name: 'color', label: '颜色', type: 'string', default: '#22d3ee' },
    ],
    defaults: { color: '#22d3ee', sizePx: 4 },
  },
  {
    key: 'line', name: '线', geometry: '线', interaction: 'polyline',
    params: [
      { name: 'points', label: '折线点', type: 'points', note: '至少 2 个点' },
      { name: 'widthPx', label: '粗细', type: 'number', unit: 'px', default: 1.6, min: 0.5, max: 20 },
      { name: 'color', label: '颜色', type: 'string', default: '#38bdf8' },
      { name: 'dashed', label: '虚线', type: 'boolean', default: false },
    ],
    defaults: { color: '#38bdf8', widthPx: 1.6, dashed: false },
  },
  {
    key: 'closedLine', name: '闭合线', geometry: '线', interaction: 'polygon',
    params: [
      { name: 'points', label: '顶点', type: 'ring', note: '至少 3 个点；首尾自动接上、**不填充**' },
      { name: 'widthPx', label: '粗细', type: 'number', unit: 'px', default: 1.6, min: 0.5, max: 20 },
      { name: 'color', label: '颜色', type: 'string', default: '#ef4444' },
      { name: 'dashed', label: '虚线', type: 'boolean', default: false },
    ],
    defaults: { color: '#ef4444', widthPx: 1.6, dashed: false },
  },
  {
    key: 'polygon', name: '面', geometry: '面', interaction: 'polygon',
    params: [
      { name: 'ring', label: '环', type: 'ring', note: '至少 3 个点；**带填充**的真面' },
      { name: 'fillColor', label: '填充色', type: 'string', default: '#22c55e' },
      { name: 'fillOpacity', label: '填充不透明度', type: 'number', default: 0.1, min: 0, max: 1 },
      { name: 'strokeWidthPx', label: '边界粗细', type: 'number', unit: 'px', default: 1.4, min: 0.5, max: 20 },
      { name: 'dashed', label: '虚线边界', type: 'boolean', default: false },
    ],
    defaults: { color: '#22c55e', widthPx: 1.4, dashed: false },
  },
  {
    key: 'circle', name: '圆', geometry: '面', interaction: 'two-point',
    params: [
      { name: 'lng', label: '圆心经度', type: 'lnglat' },
      { name: 'lat', label: '圆心纬度', type: 'lnglat' },
      { name: 'radiusKm', label: '半径', type: 'number', unit: 'km', min: 0.1, max: 200, note: '两下绘制时由第 2 个点算出' },
      { name: 'fillColor', label: '填充色', type: 'string', default: '#ef4444' },
      { name: 'fillOpacity', label: '填充不透明度', type: 'number', default: 0.1, min: 0, max: 1 },
      { name: 'strokeWidthPx', label: '边界粗细', type: 'number', unit: 'px', default: 1.2, min: 0.5, max: 20 },
      { name: 'dashed', label: '虚线边界', type: 'boolean', default: false },
    ],
    defaults: { color: '#ef4444', widthPx: 1.2, dashed: false },
  },
  {
    key: 'ellipse', name: '椭圆', geometry: '面', interaction: 'two-point',
    params: [
      { name: 'lng', label: '中心经度', type: 'lnglat' },
      { name: 'lat', label: '中心纬度', type: 'lnglat' },
      { name: 'radiusKm', label: '长半轴', type: 'number', unit: 'km', min: 0.1, max: 200 },
      { name: 'radiusKmMinor', label: '短半轴', type: 'number', unit: 'km', min: 0.05, max: 200 },
      { name: 'rotation', label: '旋转角', type: 'number', unit: '°', default: 0, min: 0, max: 360 },
      { name: 'fillColor', label: '填充色', type: 'string', default: '#f59e0b' },
      { name: 'fillOpacity', label: '填充不透明度', type: 'number', default: 0.1, min: 0, max: 1 },
      { name: 'strokeWidthPx', label: '边界粗细', type: 'number', unit: 'px', default: 1.2, min: 0.5, max: 20 },
      { name: 'dashed', label: '虚线边界', type: 'boolean', default: false },
    ],
    defaults: { color: '#f59e0b', widthPx: 1.2, dashed: false },
  },
]

/** 按 key 查一条（宿主菜单用） */
export const catalogOf = (key: string): GeometryDef | undefined =>
  PRIMITIVE_CATALOG.find((d) => d.key === key)
