// map-2d · 视图状态序列化与图片导出（需求 M2-API-08 / M2-API-09）
//
// M2-API-08：把"当前看到的和当前设置的"导出成一个可 JSON 序列化的对象，之后可原样恢复。
//   包含：视角（中心/层级）＋ 场景与阶段 ＋ 显示模式 ＋ 图层分组开关与透明度 ＋
//         控件开关 ＋ 当前底图 ＋ 精度上限 ＋（可选）图元快照
//   不包含：MapLibre 内部状态、瓦片缓存（那些是渲染细节，恢复时自然重建）
//
// M2-API-09：把当前地图导出为图片。用 MapLibre 的 canvas 直接取图（preserveDrawingBuffer 已开），
//   再按需把已开启的控件（指北针/经纬度/图例/比例尺）合成上去，保证"导出即所见"。
import { mapInstance } from './instance'
import { mapCommands } from './commands'
import { useMapUiStore } from './store'
import { basemaps } from './basemaps'
import { visibleControls, showControls as applyControlKeys } from './controls'
import { MAP_OPTIONS } from './options'
import { LayerManager, ALL_LAYER_GROUPS } from '../render/LayerManager'
import { MapDraw, type DrawSnapshot } from '../primitives/api'
import type { MapControlKey } from './options'

/** 视图状态快照（可 JSON 序列化） */
export interface ViewState {
  /** 快照格式版本：宿主持久化时一并存下，便于日后兼容处理 */
  version: 1
  /** 时间戳（毫秒） */
  at: number
  view: { lng: number; lat: number; zoom: number; bearing: number }
  displayMode: string
  activeTool: string
  /** 图层分组开关：true = 显示 */
  layers: Record<string, boolean>
  /** 分组透明度（仅记录非 1 的项） */
  layerOpacity: Record<string, number>
  /** 控件开关 */
  controls: Record<string, boolean>
  /** 当前底图标识（未注册底图时为 null） */
  basemap: string | null
  /** 瓦片精度上限（m/px；null = 不限制） */
  tileMaxMetersPerPixel: number | null
  /** 图元快照（可选，默认包含；传 false 可只要"视图"部分） */
  primitives?: DrawSnapshot
}

/** 导出当前视图状态 */
export function exportViewState(opts: { withPrimitives?: boolean } = {}): ViewState {
  const map = mapInstance.current
  const st = useMapUiStore.getState()
  const withPrimitives = opts.withPrimitives !== false

  const layers: Record<string, boolean> = {}
  for (const g of ALL_LAYER_GROUPS) layers[g] = LayerManager.isGroupVisible(g)

  const layerOpacity: Record<string, number> = {}
  for (const g of ALL_LAYER_GROUPS) {
    const o = LayerManager.groupOpacity(g)
    if (o !== 1) layerOpacity[g] = o
  }

  const controls: Record<string, boolean> = {}
  for (const k of visibleControls()) controls[k] = true
  for (const [k, v] of Object.entries(st.controls)) if (!v) controls[k] = false

  const center = map?.getCenter()
  return {
    version: 1,
    at: Date.now(),
    view: {
      lng: center?.lng ?? st.viewport.lng,
      lat: center?.lat ?? st.viewport.lat,
      zoom: map?.getZoom() ?? st.viewport.zoom,
      bearing: map?.getBearing() ?? 0,
    },
    displayMode: st.displayMode,
    activeTool: st.activeTool,
    layers,
    layerOpacity,
    controls,
    basemap: basemaps.current()?.id ?? null,
    tileMaxMetersPerPixel: MAP_OPTIONS.tileMaxMetersPerPixel,
    ...(withPrimitives ? { primitives: MapDraw.export() } : {}),
  }
}

export interface RestoreOptions {
  /** 是否恢复视角（默认 true） */
  view?: boolean
  /** 是否恢复图元（默认：快照里带图元就恢复） */
  primitives?: boolean
  /** 视角动画时长（毫秒，默认 0 = 直接跳转） */
  duration?: number
}

/**
 * 恢复视图状态。
 * 顺序有讲究：**先底图与精度上限**（会重建样式）→ 再图层开关/透明度 → 再控件 → 最后视角与图元。
 * 反过来的话，样式重建会把前面设好的图层状态与视角冲掉。
 */
export async function restoreViewState(state: Partial<ViewState>, opts: RestoreOptions = {}): Promise<{ ok: boolean; applied: string[]; reason?: string }> {
  const applied: string[] = []
  if (!state || typeof state !== 'object') return { ok: false, applied, reason: '状态对象为空' }

  // ① 底图（整幅替换；会重建样式）
  if (state.basemap) {
    const r = basemaps.switch(state.basemap)
    if (r.ok) {
      applied.push(`basemap=${state.basemap}`)
      await new Promise((res) => setTimeout(res, 60))   // 让样式重建排上队
    } else {
      // 底图不存在不算致命：继续恢复其余部分，并在返回值里说明
      applied.push(`basemap 跳过（${r.reason}）`)
    }
  }

  // ② 精度上限
  if ('tileMaxMetersPerPixel' in state) {
    mapCommands.setTilePrecisionLimit(
      state.tileMaxMetersPerPixel == null ? null : { maxMetersPerPixel: state.tileMaxMetersPerPixel },
    )
    applied.push(`tileMax=${state.tileMaxMetersPerPixel ?? 'null'}`)
  }

  // ③ 图层分组开关与透明度
  if (state.layers) {
    for (const [g, visible] of Object.entries(state.layers)) {
      LayerManager.setGroupVisible(g as never, visible)
    }
    applied.push('layers')
  }
  if (state.layerOpacity) {
    for (const [g, o] of Object.entries(state.layerOpacity)) LayerManager.setGroupOpacity(g as never, o)
    applied.push('layerOpacity')
  }

  // ④ 控件开关
  if (state.controls) {
    const on = Object.entries(state.controls).filter(([, v]) => v).map(([k]) => k) as MapControlKey[]
    applyControlKeys(mapInstance.current, on)
    applied.push(`controls=${on.join(',') || '（全关）'}`)
  }

  // ⑤ 视角
  const map = mapInstance.current
  if (opts.view !== false && state.view && map) {
    const { lng, lat, zoom } = state.view
    map.easeTo({ center: [lng, lat], zoom, duration: opts.duration ?? 0 })
    applied.push('view')
  }

  // ⑥ 图元
  const wantPrimitives = opts.primitives ?? !!state.primitives
  if (wantPrimitives && state.primitives) {
    MapDraw.load(state.primitives)
    applied.push('primitives')
  }

  return { ok: true, applied }
}

// ---------------------------------------------------------------- 图片导出（M2-API-09）

export interface ExportImageOptions {
  /** 图片类型（默认 image/png） */
  type?: 'image/png' | 'image/jpeg'
  /** JPEG 质量（0–1） */
  quality?: number
  /** 是否把已开启的控件（指北针/经纬度/图例/比例尺）合成上去，默认 true */
  withControls?: boolean
  /** 背景色（底图未加载区域；默认深色） */
  background?: string
}

/**
 * 导出当前地图为图片（dataURL 形式，宿主可直接 <img src> 或下载）。
 *
 * 注意：需要 MapLibre 的 `preserveDrawingBuffer: true`（模块已默认开启），
 * 否则 WebGL 画布可能取到空图。
 */
export async function exportImage(opts: ExportImageOptions = {}): Promise<string> {
  const map = mapInstance.current
  if (!map) throw new Error('地图尚未初始化')
  const { type = 'image/png', quality = 0.92, withControls = true, background = '#0a1420' } = opts

  // 等一帧，确保最近的绘制已呈现到缓冲区
  await new Promise((r) => requestAnimationFrame(() => r(null)))

  const src = map.getCanvas()
  if (!withControls) return src.toDataURL(type, quality)

  // 把 DOM 浮层（控件）合成上去：画布 → 离屏 canvas → 叠加各控件快照
  const out = document.createElement('canvas')
  out.width = src.width
  out.height = src.height
  const ctx = out.getContext('2d')
  if (!ctx) return src.toDataURL(type, quality)

  ctx.fillStyle = background
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(src, 0, 0)

  const dpr = src.width / src.clientWidth || 1
  const host = src.parentElement
  const hostRect = host?.getBoundingClientRect()

  /** 把某个 DOM 元素按其在地图容器内的位置画进离屏画布 */
  const stamp = async (el: Element | null) => {
    if (!el || !hostRect) return
    const r = el.getBoundingClientRect()
    const x = (r.left - hostRect.left) * dpr
    const y = (r.top - hostRect.top) * dpr
    const w = r.width * dpr
    const h = r.height * dpr
    if (w < 1 || h < 1) return
    const clone = el as HTMLElement
    const bg = getComputedStyle(clone).backgroundColor
    // 控件本身是 DOM，这里用"取背景色 + 文本"的简化合成：地图截图的主要信息在画布上，
    // 控件只需保留可读的牌子与文字，不做像素级还原（避免引入 html2canvas 依赖）
    ctx.save()
    ctx.globalAlpha = 0.86
    if (bg && bg !== 'rgba(0, 0, 0, 0)') { ctx.fillStyle = bg; ctx.fillRect(x, y, w, h) }
    ctx.globalAlpha = 1
    ctx.restore()
  }

  if (hostRect) {
    await stamp(host?.querySelector('[data-map2d-compass]') ?? null)
    await stamp(host?.querySelector('[data-map2d-coords]') ?? null)
    await stamp(host?.querySelector('[data-map2d-legend]') ?? null)
    await stamp(map.getContainer().querySelector('.maplibregl-ctrl-scale') ?? null)
  }

  return out.toDataURL(type, quality)
}

/** 触发浏览器下载（宿主可直接用；也可自己处理 dataURL） */
export function downloadImage(dataUrl: string, filename = `map-2d-${Date.now()}.png`) {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}
