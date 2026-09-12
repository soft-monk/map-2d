// map-2d · 底图管理与切换（需求 M2-MAP-09 / M2-BASE-09 ~ 13 / M2-API-10 ~ 13）
//
// 语义（见《设计文档》§10.3）：
//   · 宿主声明**多套**底图（卫星影像 / 路网 / 地形…），模块维护清单
//   · 切换 = **整幅替换**：重建整个样式（复用 MapView 的换底图路径），不做叠加与混合
//   · 切换后保持：视角不变、已绘图元重放、图层分组开关与控件开关保留
//   · 无效 id 返回 { ok:false, reason }，不抛异常、不改动当前底图
//   · 清单来源由宿主决定（前端配置或后端接口都可以），模块只消费 BasemapDef[]
import type { MapConfigData } from './types'

/** 一套底图的描述 */
export interface BasemapDef {
  /** 唯一标识（切换时用它） */
  id: string
  /** 显示名（宿主渲染下拉/按钮用） */
  name: string
  /** 类型：栅格瓦片 / 样式 URL */
  type?: 'raster' | 'style'
  /** 本地栅格瓦片模板（type=raster 时必填） */
  tiles?: string
  /** 在线样式 URL（type=style 时必填） */
  styleUrl?: string
  /** 可用层级范围（信息展示 + 约束） */
  minZoom?: number
  maxZoom?: number
  /** 地面分辨率（米/像素，可选；信息展示用） */
  metersPerPixel?: number
  /** 版权署名 */
  attribution?: string
  /** 其他宿主自定义字段（原样带回） */
  [k: string]: unknown
}

/** 底图清单项（list() 的返回形状） */
export interface BasemapInfo extends BasemapDef {
  isCurrent: boolean
}

export type BasemapListener = (def: BasemapDef | null) => void

let defs: BasemapDef[] = []
let currentId: string | null = null
const listeners = new Set<BasemapListener>()

/** 库内广播：MapView 监听它来真正重建样式并重放图元 */
const CHANGE_EVENT = 'map2d:basemap-change'

function normalize(def: BasemapDef): BasemapDef {
  const type = def.type ?? (def.styleUrl ? 'style' : 'raster')
  return { ...def, type }
}

function announce(def: BasemapDef | null) {
  for (const fn of [...listeners]) {
    try { fn(def) } catch { /* 单个监听器异常不影响其他 */ }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: def }))
  }
}

export const basemaps = {
  /** 整份设置清单（例如从后端接口拉到的清单） */
  setList(list: BasemapDef[]): BasemapInfo[] {
    defs = list.map(normalize)
    if (currentId && !defs.some((d) => d.id === currentId)) currentId = null
    if (!currentId && defs.length) currentId = defs[0].id
    return this.list()
  },

  /** 追加一套（或按 id 覆盖同 id 的一套） */
  register(def: BasemapDef): BasemapInfo[] {
    const d = normalize(def)
    const i = defs.findIndex((x) => x.id === d.id)
    if (i >= 0) defs[i] = d
    else defs.push(d)
    if (!currentId) currentId = d.id
    return this.list()
  },

  /** 移除一套；若移除的是当前底图，回落到清单第一套并广播一次变更 */
  unregister(id: string): { ok: boolean; current?: BasemapDef | null } {
    const i = defs.findIndex((x) => x.id === id)
    if (i < 0) return { ok: false }
    defs.splice(i, 1)
    if (currentId === id) {
      currentId = defs.length ? defs[0].id : null
      announce(this.current())
    }
    return { ok: true, current: this.current() }
  },

  /** 全部底图清单（含是否当前） */
  list(): BasemapInfo[] {
    return defs.map((d) => ({ ...d, isCurrent: d.id === currentId }))
  },

  /** 当前底图 */
  current(): BasemapDef | null {
    return defs.find((d) => d.id === currentId) ?? null
  },

  /**
   * 切换底图。返回 { ok, current } 或 { ok:false, reason }；
   * 无效 id / 已是当前 / 清单为空都会给出可读原因，且**不改动当前底图**。
   */
  switch(id: string): { ok: true; current: BasemapDef } | { ok: false; reason: string } {
    const def = defs.find((d) => d.id === id)
    if (!def) return { ok: false, reason: `未找到底图：${id}` }
    if (def.id === currentId) return { ok: false, reason: 'already-current' }
    currentId = def.id
    announce(def)
    return { ok: true, current: def }
  },

  /** 订阅切换通知；返回取消订阅函数 */
  onChange(fn: BasemapListener): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  /** 把某套底图转换成地图容器需要的配置形状（保持视角等其余字段取模板） */
  toConfig(def: BasemapDef, template?: MapConfigData | null): MapConfigData {
    const base = template ?? {
      center: [116.3974, 39.9093] as [number, number],
      zoom: 11, minZoom: 3, maxZoom: 16,
      basemap: { tileUrlTemplate: '', attribution: '' },
    }
    return {
      ...base,
      basemap: {
        tileUrlTemplate: def.tiles ?? '',
        attribution: def.attribution ?? '',
        styleUrl: def.styleUrl,
      },
    }
  },

  /** 清空（测试与重置用） */
  reset() {
    defs = []
    currentId = null
    listeners.clear()
  },
}

/** MapView 内部使用：监听底图切换（与 onChange 相同的事件源，单独取名以免混淆） */
export const BASEMAP_CHANGE_EVENT = CHANGE_EVENT

/** 取当前底图对应的配置（MapView 建图时用；没注册任何底图时返回 null，走宿主传入的配置） */
export function initialBasemapConfig(template?: MapConfigData | null): MapConfigData | null {
  const cur = basemaps.current()
  return cur ? basemaps.toConfig(cur, template) : null
}
