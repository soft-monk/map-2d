// map-2d · 军事标绘符号库（需求 M2-DRAW-16，按国军标 GJB 符号体系）
//
// 说明与边界（避免夸大）：这里实现的是**国军标符号体系的图形化表达**——
//   框线 + 图形 + 颜色三要素，符合 GJB 840《军用地图与态势图图式》里
//   "单位符号 = 框（隶属/等级）+ 图形（兵种/专业）+ 颜色（敌我）"的组织方式。
//   模块不内置完整符号字典（那是几百上千个符号的事，且各军兵种图式有差异），
//   而是**给出可扩展的实现**：内置 12 个常用兵种符号，并开放 `registerSymbol()` 让宿主
//   按自己的图式补充；符号以 SVG 内联生成，不依赖图标字体或外部图片。
//
// 渲染方式：生成 SVG → 注册为 MapLibre image → 用 symbol 图层按图元属性绘制，
// 支持旋转（icon-rotate）与缩放（icon-size），因此同一符号可用于任意朝向的态势。
import type { Map as MlMap } from 'maplibre-gl'
import { mapInstance } from './instance'
import { LayerManager } from '../render/LayerManager'
import { rasterizeSymbol } from './symbolRaster'

/** 敌我属性（决定框形与颜色，GJB 惯例：红方/蓝方/绿方/黄方） */
export type SymbolAffiliation = 'friend' | 'hostile' | 'neutral' | 'unknown'

/** 内置兵种符号 key */
export type SymbolKey =
  | 'infantry'      // 步兵
  | 'armor'         // 装甲
  | 'artillery'     // 炮兵
  | 'missile'       // 导弹
  | 'radar'         // 雷达
  | 'command'       // 指挥所
  | 'recon'         // 侦察
  | 'ew'            // 电子对抗
  | 'logistics'     // 后勤
  | 'medical'       // 卫生
  | 'aviation'      // 航空兵
  | 'uav'           // 无人机

export interface SymbolDef {
  key: string
  /** 中文名（用于图例与调试） */
  name: string
  /** 生成 SVG（viewBox 固定 0 0 32 32；返回字符串） */
  svg: (stroke: string) => string
}

/** 敌我配色（与图元调色板一致的语义：红=敌方、蓝=我方、绿=中立、黄=不明） */
export const AFFILIATION_COLOR: Record<SymbolAffiliation, string> = {
  friend: '#3b82f6',
  hostile: '#ef4444',
  neutral: '#22c55e',
  unknown: '#f59e0b',
}

/** 框形（GJB：我方=矩形、敌方=菱形/尖角、中立=方形、不明=圆角） */
function frame(aff: SymbolAffiliation, stroke: string): string {
  const s = `fill="none" stroke="${stroke}" stroke-width="2"`
  switch (aff) {
    case 'hostile':
      // 敌方：菱形
      return `<polygon points="16,2 30,16 16,30 2,16" ${s}/>`
    case 'neutral':
      return `<rect x="3" y="3" width="26" height="26" ${s}/>`
    case 'unknown':
      return `<rect x="3" y="3" width="26" height="26" rx="7" ${s}/>`
    case 'friend':
    default:
      return `<rect x="2" y="8" width="28" height="16" ${s}/>`
  }
}

/** 图形（兵种/专业标识，画在框内） */
const GLYPH: Record<SymbolKey, (stroke: string) => string> = {
  // 步兵：交叉线
  infantry: (s) => `<path d="M7 11 L25 21 M25 11 L7 21" fill="none" stroke="${s}" stroke-width="1.8"/>`,
  // 装甲：椭圆（履带意象）
  armor: (s) => `<ellipse cx="16" cy="16" rx="9" ry="5" fill="none" stroke="${s}" stroke-width="1.8"/>`,
  // 炮兵：实心圆点
  artillery: (s) => `<circle cx="16" cy="16" r="3.4" fill="${s}"/>`,
  // 导弹：向上箭头
  missile: (s) => `<path d="M16 9 L21 21 L16 18 L11 21 Z" fill="${s}"/>`,
  // 雷达：弧线 + 中心点
  radar: (s) => `<path d="M9 19 A8 8 0 0 1 23 13" fill="none" stroke="${s}" stroke-width="1.8"/><circle cx="16" cy="19" r="2" fill="${s}"/>`,
  // 指挥所：旗杆 + 旗
  command: (s) => `<path d="M13 9 L13 23" stroke="${s}" stroke-width="1.8"/><path d="M13 10 L22 13 L13 16 Z" fill="${s}"/>`,
  // 侦察：眼睛
  recon: (s) => `<path d="M9 16 Q16 9 23 16 Q16 23 9 16 Z" fill="none" stroke="${s}" stroke-width="1.6"/><circle cx="16" cy="16" r="2.2" fill="${s}"/>`,
  // 电子对抗：闪电
  ew: (s) => `<path d="M18 8 L12 17 L16 17 L14 24 L21 14 L17 14 Z" fill="${s}"/>`,
  // 后勤：方形补给箱
  logistics: (s) => `<rect x="11" y="11" width="10" height="10" fill="none" stroke="${s}" stroke-width="1.8"/><path d="M11 16 H21 M16 11 V21" stroke="${s}" stroke-width="1.2"/>`,
  // 卫生：十字
  medical: (s) => `<path d="M16 10 V22 M10 16 H22" stroke="${s}" stroke-width="3"/>`,
  // 航空兵：机翼
  aviation: (s) => `<path d="M16 8 L16 24 M9 15 L23 15 M11 20 L21 20" stroke="${s}" stroke-width="1.8" fill="none"/>`,
  // 无人机：三角翼 + 螺旋桨
  uav: (s) => `<path d="M16 20 L10 10 H22 Z" fill="none" stroke="${s}" stroke-width="1.8"/><path d="M10 10 H22" stroke="${s}" stroke-width="2"/>`,
}

/** 内置符号表 */
export const SYMBOLS: Record<SymbolKey, SymbolDef> = Object.fromEntries(
  (Object.keys(GLYPH) as SymbolKey[]).map((k) => [
    k,
    {
      key: k,
      name: ({
        infantry: '步兵', armor: '装甲', artillery: '炮兵', missile: '导弹', radar: '雷达',
        command: '指挥所', recon: '侦察', ew: '电子对抗', logistics: '后勤', medical: '卫生',
        aviation: '航空兵', uav: '无人机',
      } as Record<SymbolKey, string>)[k],
      svg: (stroke: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${frame('friend', stroke)}${GLYPH[k](stroke)}</svg>`,
    },
  ]),
) as Record<SymbolKey, SymbolDef>

/** 宿主自定义符号（覆盖或新增） */
const custom = new Map<string, SymbolDef>()

export function registerSymbol(def: SymbolDef): void {
  custom.set(def.key, def)
}

export function symbolNames(): { key: string; name: string }[] {
  return [
    ...Object.values(SYMBOLS).map((s) => ({ key: s.key, name: s.name })),
    ...[...custom.values()].map((s) => ({ key: s.key, name: `(自定义) ${s.name}` })),
  ]
}

/** 生成某符号在指定敌我属性下的 SVG（框形与图形都按属性着色） */
export function symbolSvg(key: string, aff: SymbolAffiliation = 'friend'): string {
  const color = AFFILIATION_COLOR[aff]
  const c = custom.get(key)
  if (c) return c.svg(color)
  const def = (SYMBOLS as Record<string, SymbolDef>)[key]
  if (!def) return SYMBOLS.infantry.svg(color)
  // 内置符号的框形随属性变化，图形沿用原来的
  const g = (GLYPH as Record<string, (s: string) => string>)[key] ?? GLYPH.infantry
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${frame(aff, color)}${g(color)}</svg>`
}

/** 图片名规则：同一符号在不同属性下是不同图片 */
export function imageName(key: string, aff: SymbolAffiliation): string {
  return `m2sym-${key}-${aff}`
}

const registered = new WeakMap<MlMap, Set<string>>()

/**
 * 把用到的符号注册成 MapLibre 图片（幂等）。
 * 只在真正需要时注册，避免一次性塞几十张图进样式。
 */
export function ensureSymbolImages(map: MlMap, keys: { key: string; aff: SymbolAffiliation }[]): void {
  let set = registered.get(map)
  if (!set) { set = new Set(); registered.set(map, set) }
  for (const { key, aff } of keys) {
    const name = imageName(key, aff)
    if (set.has(name)) continue
    if (map.hasImage(name)) { set.add(name); continue }
    try {
      // 同步栅格化：MapLibre 的 addImage 需要立即拿到像素，
      // 而 SVG data URL 是异步解码的（同步 drawImage 会得到空图）——因此不用 SVG。
      map.addImage(name, rasterizeSymbol(key, aff, AFFILIATION_COLOR[aff]))
    } catch (e) {
      console.warn('[map-2d] 符号图片注册失败：', key, aff, e)
    }
    set.add(name)
  }
}

/** 图元属性 → 图片名（供渲染层使用） */
export function symbolImageFor(props: { symbol?: string; affiliation?: SymbolAffiliation }): string | null {
  if (!props.symbol) return null
  return imageName(props.symbol, props.affiliation ?? 'friend')
}

/** 把符号图元写入地图（渲染层调用） */
export function renderSymbols(map: MlMap, features: GeoJSON.Feature[]): void {
  const keys = features
    .map((f) => (f.properties ?? {}) as { symbol?: string; affiliation?: SymbolAffiliation })
    .filter((p) => !!p.symbol)
    .map((p) => ({ key: p.symbol as string, aff: (p.affiliation ?? 'friend') as SymbolAffiliation }))
  ensureSymbolImages(map, keys)
  // 关键：把 icon 图片名**写进要素属性**——symbol 图层用 ['get','icon'] 取图，
  // 属性里没有 icon 就什么也画不出来（这是首版符号"看不见"的直接原因）。
  const withIcon = features.map((f) => {
    const p = (f.properties ?? {}) as { symbol?: string; affiliation?: SymbolAffiliation }
    return { ...f, properties: { ...p, icon: symbolImageFor(p) } }
  })
  LayerManager.setSymbolFeatures({ type: 'FeatureCollection', features: withIcon } as GeoJSON.FeatureCollection)
}

/** 便捷：当前地图实例（渲染层用） */
export function activeMap(): MlMap | null {
  return mapInstance.current
}
