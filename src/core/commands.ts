// map-2d · 视角命令（命令式 API，宿主可主动控制地图）
import { mapInstance } from './instance'
import { LayerManager } from '../render/LayerManager'
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

  /** 未初始化时返回 false，宿主可据此决定何时调用 */
  isReady(): boolean {
    return !!mapInstance.current
  },
}
