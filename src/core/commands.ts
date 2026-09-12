// map-2d · 视角命令（命令式 API，宿主可主动控制地图）
import { mapInstance, layersReady } from './instance'
import { LayerManager } from '../render/LayerManager'
import { MAP_OPTIONS, zoomToMetersPerPixel, type MapControlKey } from './options'
import { showControls, toggleControl, visibleControls, controlState } from './controls'
import { tileMaxZoomFromOptions, applyTilePrecision } from './tilePrecision'
import { basemaps, type BasemapDef, type BasemapInfo } from './basemaps'
import { stats as runtimeStats, onPrimitiveError, type PrimitiveError, type RuntimeStats } from './diagnostics'
import type { MapConfigData, MapViewport } from './types'

export const mapCommands = {
  /** 立即设置视角 */
  setView(lng: number, lat: number, zoom?: number, durationMs = 0) {
    const map = mapInstance.current
    if (!map) return
    const z = zoom ?? map.getZoom()
    if (durationMs > 0) map.easeTo({ center: [lng, lat], zoom: z, duration: durationMs })
    else map.jumpTo({ center: [lng, lat], zoom: z })
  },

  /** 平滑飞行 */
  flyTo(lng: number, lat: number, zoom?: number, durationMs = 900) {
    const map = mapInstance.current
    if (!map) return
    map.flyTo({ center: [lng, lat], zoom: zoom ?? map.getZoom(), duration: durationMs })
  },

  /** 聚焦某点（默认街道级） */
  focus(lng: number, lat: number, zoom = 13) {
    LayerManager.focus(lng, lat, zoom)
  },

  /** 复位到配置中的初始视角 */
  resetView(config?: MapConfigData | null) {
    const map = mapInstance.current
    if (!map) return
    const c = config?.center ?? [116.3974, 39.9093]
    const z = config?.zoom ?? 11
    map.easeTo({ center: [c[0], c[1]], zoom: z, bearing: 0, duration: 500 })
  },

  /** 相对缩放 */
  zoomBy(delta: number) {
    mapInstance.current?.easeTo({ zoom: (mapInstance.current?.getZoom() ?? 11) + delta, duration: 220 })
  },

  /** 读取当前视口 */
  getViewport(): MapViewport {
    const map = mapInstance.current
    if (!map) return { lng: 0, lat: 0, zoom: 0, bearing: 0 }
    const c = map.getCenter()
    return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing() }
  },

  /**
   * 地图是否**可画**（图层已建立）。
   *
   * 注意：判据不是"实例是否创建"——`new Map()` 之后实例立即有值，但那时数据源还没建立，
   * 此时写图元会落到不存在的源上。模块内部已对这种情况做了排队（数据保留、就绪后补画），
   * 但宿主最好等本方法返回 true 再灌数据，语义最清晰。
   */
  isReady(): boolean {
    return layersReady.current && !!mapInstance.current
  },

  // ------------------------------------------------------------ 控件按需显示（M2-CTRL-01 ~ 05）
  /** 显示/隐藏指定控件；`on=false` 关闭。未列出的控件保持原状 */
  showControls(keys: MapControlKey | MapControlKey[], on = true) {
    showControls(mapInstance.current, Array.isArray(keys) ? keys : [keys], on)
  },

  /** 切换单个控件的显示状态 */
  toggleControl(key: MapControlKey) {
    toggleControl(mapInstance.current, key)
  },

  /** 当前显示的控件清单 */
  getControls(): MapControlKey[] {
    return visibleControls()
  },

  /** 读取控件开关状态（含未显示的） */
  getControlState(): Record<MapControlKey, boolean> {
    return controlState()
  },

  // ------------------------------------------------------------ 瓦片精度上限（M2-BASE-05）
  /**
   * 限制底图只使用到指定精度（超过上限的层级不再请求，改用较粗瓦片放大显示）。
   * 传 `null` 取消限制；传 `{ maxZoom }` 或 `{ maxMetersPerPixel }` 设定上限。
   * 返回实际生效的最大层级（null 表示不限制）。
   */
  setTilePrecisionLimit(limit: { maxMetersPerPixel?: number; maxZoom?: number } | null): number | null {
    if (limit == null) {
      MAP_OPTIONS.tileMaxMetersPerPixel = null
      applyTilePrecision()
      return null
    }
    MAP_OPTIONS.tileMaxMetersPerPixel =
      limit.maxMetersPerPixel ?? (limit.maxZoom != null ? zoomToMetersPerPixel(limit.maxZoom) : null)
    return MAP_OPTIONS.tileMaxMetersPerPixel == null ? null : applyTilePrecision()
  },

  /** 读取当前精度上限（未设置返回 null） */
  getTilePrecisionLimit(): { maxMetersPerPixel: number; maxZoom: number } | null {
    const mpp = MAP_OPTIONS.tileMaxMetersPerPixel
    if (mpp == null) return null
    return { maxMetersPerPixel: mpp, maxZoom: tileMaxZoomFromOptions() }
  },

  // ------------------------------------------------------------ 底图管理（M2-API-10 ~ 13）
  /** 底图清单（含是否当前） */
  listBasemaps(): BasemapInfo[] {
    return basemaps.list()
  },

  /** 当前底图 */
  currentBasemap(): BasemapDef | null {
    return basemaps.current()
  },

  /** 按标识切换底图（整幅替换）；无效标识返回可读原因，不抛异常 */
  switchBasemap(id: string) {
    return basemaps.switch(id)
  },

  /** 订阅底图切换通知；返回取消订阅函数 */
  onBasemapChange(fn: (def: BasemapDef | null) => void): () => void {
    return basemaps.onChange(fn)
  },

  // ------------------------------------------------------------ 诊断（M2-CTRL-15 / M2-NFR-10）
  /** 运行指标：帧率、各类图元数量、瓦片缓存量、最近一次提交耗时、JS 堆 */
  getStats(): RuntimeStats {
    return runtimeStats()
  },

  /** 订阅"图元数据非法"上报；返回取消订阅函数 */
  onPrimitiveError(fn: (e: PrimitiveError) => void): () => void {
    return onPrimitiveError(fn)
  },
}
