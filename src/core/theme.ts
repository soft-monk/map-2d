// map-2d · 命名样式模板与主题（需求 M2-DRAW-15 样式模板 / M2-CTRL-13 主题热切换）
//
// 【样式模板 M2-DRAW-15】
//   宿主集中登记一套命名样式（颜色/线型/字号/透明度），图元只写 `style: '告警红'`。
//   要点：**改模板即批量生效**——因为图元存的是模板名，渲染时才解析；
//   所以 setStyleTemplates() 之后调一次 render() 就能让所有引用者一起变。
//   图元自身的字段优先级**高于**模板（便于个别覆盖）。
//
// 【主题 M2-CTRL-13】
//   三套预设：日间 / 夜间 / 高对比。主题包含两部分：
//     · 底图参数：亮度、饱和度、对比度（用栅格图层的 paint 属性实现，不动瓦片本身）
//     · 图元配色：浅色/深色底下的可读性调整（标签底色、描边等）
//   运行中切换**不需要刷新**：改的是已存在图层的 paint 属性。
import { LayerManager } from '../render/LayerManager'
import { mapInstance } from './instance'
import { useMapUiStore } from './store'

// ---------------------------------------------------------------- 样式模板

/** 一条命名样式：字段与图元的样式字段同名（color/opacity/dashed/weight/size/radiusKm 除外） */
export interface StyleTemplate {
  color?: string
  opacity?: number
  dashed?: boolean
  weight?: number
  size?: number
  /** 圆形图元的半径（公里）——供统一的"圆样式"使用 */
  radiusKm?: number
  /** 线帽/线接头等附加 paint 字段（原样透传） */
  extra?: Record<string, unknown>
}

const templates = new Map<string, StyleTemplate>()

/** 登记/替换样式模板（可一次登记多个；同名覆盖） */
export function setStyleTemplates(defs: Record<string, StyleTemplate>): { count: number; names: string[] } {
  for (const [name, def] of Object.entries(defs)) templates.set(name, def)
  return { count: templates.size, names: [...templates.keys()] }
}

/** 追加/替换单个模板 */
export function defineStyle(name: string, def: StyleTemplate) {
  templates.set(name, def)
  return { ...def }
}

/** 删除模板（已引用它的图元会回落为"无模板"，即使用自身字段与内置调色板） */
export function removeStyle(name: string): boolean {
  return templates.delete(name)
}

/** 全部模板名 */
export function styleNames(): string[] {
  return [...templates.keys()]
}

/** 读取某个模板（副本，避免外部改到内部状态） */
export function getStyle(name: string): StyleTemplate | undefined {
  const t = templates.get(name)
  return t ? { ...t } : undefined
}

/** 清空全部模板（测试/重置用） */
export function clearStyles() {
  templates.clear()
}

/**
 * 解析图元的最终样式：模板值打底，图元自身字段覆盖。
 * 未登记模板名时返回图元自身字段（并在控制台提示一次，便于排错）。
 */
const warned = new Set<string>()
export function resolveStyle<T extends Record<string, unknown>>(item: T): T {
  const name = item.style as string | undefined
  if (!name) return item
  const tpl = templates.get(name)
  if (!tpl) {
    if (!warned.has(name)) {
      warned.add(name)
      console.warn(`[map-2d] 未登记的样式模板：${name}（将只使用图元自身字段）`)
    }
    return item
  }
  // 图元字段优先：只补模板里有、图元里没有的字段
  const out: Record<string, unknown> = { ...tpl, ...tpl.extra, ...item }
  delete out.extra
  return out as T
}

// ---------------------------------------------------------------- 主题

export type ThemeKey = 'day' | 'night' | 'contrast'

export interface ThemeDef {
  key: ThemeKey
  name: string
  /** 底图栅格参数（MapLibre raster paint） */
  raster: {
    brightnessMin?: number
    brightnessMax?: number
    saturation?: number
    contrast?: number
    /** 叠加色（用于夜间压暗偏蓝） */
    tint?: string
    tintOpacity?: number
  }
  /** 图元层的可读性参数 */
  graphic: {
    /** 标签描边色（浅色底用深描边、深色底用白描边） */
    haloColor: string
    haloWidth: number
    /** 标签文字色 */
    textColor: string
  }
}

export const THEMES: Record<ThemeKey, ThemeDef> = {
  day: {
    key: 'day', name: '日间',
    raster: { brightnessMin: 0.06, brightnessMax: 0.72, saturation: -0.28, contrast: 0.06, tint: '#ffffff', tintOpacity: 0.06 },
    graphic: { haloColor: 'rgba(255,255,255,.9)', haloWidth: 2.2, textColor: '#1b2a3a' },
  },
  night: {
    key: 'night', name: '夜间',
    // 亮度上限 0.42 → 0.72：实测 0.42 会把影像压得过暗（画面平均亮度仅 55，
    // 且快速缩放时"暗"与"缺口底色"不易区分）。0.72 与日间同档，
    // 但保留偏冷叠加与更高对比，仍是夜间战术观感而非"看不清"。
    raster: { brightnessMin: 0.06, brightnessMax: 0.72, saturation: -0.32, contrast: 0.14, tint: '#0a1a33', tintOpacity: 0.22 },
    graphic: { haloColor: 'rgba(5,10,20,.85)', haloWidth: 1.8, textColor: '#cfe3f5' },
  },
  contrast: {
    key: 'contrast', name: '高对比',
    raster: { brightnessMin: 0, brightnessMax: 0.95, saturation: -0.1, contrast: 0.35, tint: '#000000', tintOpacity: 0.05 },
    graphic: { haloColor: 'rgba(0,0,0,.95)', haloWidth: 3, textColor: '#ffffff' },
  },
}

let currentTheme: ThemeKey = 'night'

export function currentThemeKey(): ThemeKey {
  return currentTheme
}

/** 应用主题（运行中热切换：只改已存在图层的 paint 属性，不重建样式、不刷新页面） */
export function applyTheme(key: ThemeKey): { ok: boolean; theme: ThemeKey; reason?: string } {
  const def = THEMES[key]
  if (!def) return { ok: false, theme: currentTheme, reason: `未定义的主题：${key}` }
  const map = mapInstance.current
  currentTheme = key
  // 同步到模块 UI 状态（宿主可据此调整自己的面板配色）
  const st = useMapUiStore.getState() as unknown as { theme?: ThemeKey; setTheme?: (t: ThemeKey) => void }
  if (typeof st.setTheme === 'function') st.setTheme(key)

  if (!map) return { ok: true, theme: key }   // 地图未就绪时只记状态，建图后会套用

  const r = def.raster
  const set = (layerId: string, prop: string, value: unknown) => {
    if (!map.getLayer(layerId)) return
    try { map.setPaintProperty(layerId, prop as never, value as never) } catch { /* 图层不支持则跳过 */ }
  }

  // 底图：亮度/饱和度/对比度 + 叠加色
  for (const id of LayerManager.baseLayerIds()) {
    set(id, 'raster-brightness-min', r.brightnessMin ?? 0)
    set(id, 'raster-brightness-max', r.brightnessMax ?? 1)
    set(id, 'raster-saturation', r.saturation ?? 0)
    set(id, 'raster-contrast', r.contrast ?? 0)
  }
  // 叠加色层（base-tint 是模块自带的着色层）
  for (const id of LayerManager.tintLayerIds()) {
    set(id, 'fill-color', r.tint ?? '#000000')
    set(id, 'fill-opacity', r.tintOpacity ?? 0)
  }
  // 图元标签可读性
  for (const id of LayerManager.labelLayerIds()) {
    set(id, 'text-halo-color', def.graphic.haloColor)
    set(id, 'text-halo-width', def.graphic.haloWidth)
    set(id, 'text-color', def.graphic.textColor)
  }

  return { ok: true, theme: key }
}

/** 读取某一主题的参数（不改动地图） */
export function getTheme(key?: ThemeKey): ThemeDef {
  return THEMES[key ?? currentTheme]
}

/**
 * 换底图/重建样式之后重新套用主题。
 * 由 MapView 在样式重建完成后调用——否则新样式会退回默认观感。
 */
export function reapplyTheme() {
  return applyTheme(currentTheme)
}
