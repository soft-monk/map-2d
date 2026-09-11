// 地图模块 · 地图容器（唯一对外渲染入口）
//
// 职责边界：只负责"把数据画成地图"——初始化 MapLibre、管理图层、叠加地图级控件
// （指北针/工具条/显示模式徽标由调用方以 children 传入或直接从本模块引入）。
// 数据经 props 注入（MapData），模块自身不读应用 store。
import React, { useEffect, useRef, useState } from 'react'
import maplibregl, { Map as MlMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { LayerManager } from '../render/LayerManager'
import { MapDraw } from '../primitives/api'
import { mapInstance } from '../core/instance'
import { MAP_OPTIONS } from '../core/options'
import { useMapUiStore } from '../core/store'
import type { MapConfigData, MapData } from '../core/types'

// 视口内暂无任何瓦片时的底色（兜底样式 / 底图尚未出现的第一帧）。
// 取深蓝灰而非近黑：即使出现也会被当成"地面"，不会形成刺眼黑框。
const VOID_BG = '#08111f'

// 底图缺口处的"地面"色。瓦片尚未到达时先露出它，视觉上接近压暗后的影像，
// 避免近黑背景在暗色影像上形成一块明显的黑框。
const GAP_BG = '#16283a'

// 高清瓦片可用到的最大级别
const BASE_MAX_ZOOM = 14

/** 1×1 透明 PNG：低清源在没有瓦片模板（在线样式底图）时用它占位，保持图层结构稳定 */
const BLANK_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** 无瓦片时的兜底样式：纯底，保证任何环境都能打开 */
function fallbackStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': VOID_BG } }],
  }
}

/**
 * 底图样式选择：本地栅格瓦片 / 在线样式 / 纯色兜底。
 *
 * 本地栅格的"低清地板层"深度取 `MAP_OPTIONS.preloadMaxZoom`（默认 5，配合启动预热）。
 */
function rasterStyle(tileUrl: string, attribution: string): maplibregl.StyleSpecification {
  const floorZoom = clampFloorZoom(MAP_OPTIONS.preloadMaxZoom)
  // 署名是否交给 MapLibre 由 MAP_OPTIONS.showAttribution 决定：
  // 关闭时不写入 source.attribution，避免控件隐藏但样式里仍残留署名文本。
  const attrib = MAP_OPTIONS.showAttribution ? { attribution } : {}
  // 地板层与高清层用同一个瓦片模板；两者只需一层就够时（floorZoom 触顶）不重复请求。
  const twoTier = floorZoom < BASE_MAX_ZOOM
  return {
    version: 8,
    sources: {
      // 高清层：maxzoom 压到地板层深度——**缩放时不再逐级拉新金字塔层**，而是由 MapLibre
      // 把地板层的瓦片放大顶住（overzoom）。实测：逐级拉层会出现 245 ms 的整屏底色，压到
      // 地板层后降到 33 ms（同一套"缩到最小 + 来回拖"动作）。
      base: {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: floorZoom,
        ...attrib,
      },
      'base-underlay': {
        type: 'raster',
        tiles: twoTier ? [tileUrl] : [],
        tileSize: 256,
        maxzoom: floorZoom,
        ...(twoTier ? {} : { url: BLANK_PIXEL }),
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': GAP_BG } },
      // 低清地板层：全球覆盖、启动时整层预热，任何时刻都有内容垫底
      {
        id: 'base-underlay',
        type: 'raster',
        source: 'base-underlay',
        paint: {
          'raster-opacity': 0.9,
          'raster-saturation': -0.35,
          'raster-brightness-max': 0.8,
          'raster-fade-duration': MAP_OPTIONS.rasterFadeDuration,
        },
      },
      // 注意：MapLibre raster 只支持 raster-* 属性，不要写 'background-tint'。
      {
        id: 'base',
        type: 'raster',
        source: 'base',
        paint: {
          'raster-opacity': 1,
          'raster-saturation': -0.55,
          'raster-contrast': 0.16,
          'raster-brightness-min': 0.03,
          'raster-brightness-max': 0.62,
          'raster-fade-duration': MAP_OPTIONS.rasterFadeDuration,
        },
      },
      // 统一色调（只作用于上层，地板层保持较亮，缺口才不会被越描越黑）
      { id: 'base-tint', type: 'background', paint: { 'background-color': 'rgba(6, 26, 52, 0.16)' } },
    ],
  }
}

/** 地板层深度：0/负数（关闭预热）时退化为 1，避免出现 maxzoom 为 0 的畸形源 */
function clampFloorZoom(v: number): number {
  const z = Math.round(v)
  if (!Number.isFinite(z) || z <= 0) return 1
  return Math.min(z, BASE_MAX_ZOOM)
}

const DEFAULT_CENTER: [number, number] = [116.3974, 39.9093]
const DEFAULT_ZOOM = 11

/** 底图样式选择：在线样式 URL > 本地栅格瓦片 > 纯色兜底 */
function buildStyle(cfg: MapConfigData | null): maplibregl.StyleSpecification | string {
  const b = cfg?.basemap
  if (b?.styleUrl) return b.styleUrl
  if (b?.tileUrlTemplate) return rasterStyle(b.tileUrlTemplate, b.attribution)
  return fallbackStyle()
}

export const MapView: React.FC<{ data: MapData; children?: React.ReactNode }> = ({ data, children }) => {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const setViewport = useMapUiStore((s) => s.setViewport)
  // 初始化只做一次：用挂载时的配置快照
  const bootRef = useRef<MapData>(data)

  useEffect(() => {
    if (!hostRef.current) return
    const cfg = bootRef.current.config
    const center: [number, number] = cfg?.center ?? DEFAULT_CENTER
    const zoom = cfg?.zoom ?? DEFAULT_ZOOM

    const style = buildStyle(cfg)

    const map = new maplibregl.Map({
      container: hostRef.current,
      style,
      center,
      zoom,
      minZoom: cfg?.minZoom ?? 3,
      maxZoom: cfg?.maxZoom ?? 16,
      // 版权署名开关见 options.ts（默认隐藏；合规责任由使用方承担）
      attributionControl: MAP_OPTIONS.showAttribution ? { compact: MAP_OPTIONS.compactAttribution } : false,
      // 瓦片不做淡入：由样式里各栅格图层的 raster-fade-duration = 0 控制（见 MAP_OPTIONS）
      // preserveDrawingBuffer：允许把画布内容导出为图片（截图/汇报取图）
      preserveDrawingBuffer: true,
      dragRotate: false,      // 仅二维：禁旋转（指北针因此恒指正北）
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    })
    mapInstance.current = map

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')

    map.on('load', () => {
      LayerManager.init(map)
      LayerManager.applyVisibility()   // 恢复用户此前的图层开关
      setReady(true)
    })

    const syncViewport = () => {
      const c = map.getCenter()
      setViewport({ lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing() })
    }
    map.on('move', syncViewport)
    map.on('rotate', syncViewport)

    // 瓦片加载失败只统计，不隐藏图层（避免一个缺失瓦片把整张底图关掉）
    let tileFailures = 0
    map.on('error', (e) => {
      const msg = String((e as { error?: { message?: string } })?.error?.message ?? '')
      if (/tile|raster|image|404/i.test(msg)) {
        tileFailures += 1
        if (tileFailures === 1 || tileFailures % 20 === 0) {
          console.warn(`[map] 瓦片加载失败累计 ${tileFailures} 次（底图保持显示，缺失处露出深色底）`, msg)
        }
      }
    })

    return () => {
      map.remove()
      mapInstance.current = null
      setReady(false)
    }
  }, [setViewport])

  // 场景/任务切换 → 平滑移动视角
  const config = data.config
  useEffect(() => {
    const map = mapInstance.current
    if (!map || !config) return
    const [lng, lat] = config.center
    map.easeTo({ center: [lng, lat], zoom: config.zoom, duration: 600 })
  }, [config])

  // 底图切换（独立宿主可在运行中切换"本地瓦片 ↔ 在线样式"）
  const basemapKey = `${config?.basemap?.styleUrl ?? ''}|${config?.basemap?.tileUrlTemplate ?? ''}`
  const firstBasemapRef = useRef(true)
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    if (firstBasemapRef.current) { firstBasemapRef.current = false; return }
    map.setStyle(buildStyle(config) as never)
    const onStyled = () => {
      // setStyle 会清空所有 source/layer，需要重建并重放绘图 API 的图元
      if (!map.getSource('src-area')) {
        LayerManager.init(map)
        LayerManager.applyVisibility()
      }
      MapDraw.render()
    }
    map.once('styledata', onStyled)
  }, [basemapKey])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="map-vignette" />
      {ready && <LayerSync data={data} />}
      {children}
    </div>
  )
}

/** 把业务数据同步到地图图层（模块内部实现，数据全部来自 props） */
const LayerSync: React.FC<{ data: MapData }> = ({ data }) => {
  const { scenarioKey, phase, targets, selectedTargetId, groups, uavs, edges, topology, track } = data

  useEffect(() => {
    LayerManager.setScenario(scenarioKey)
    LayerManager.setPhase(phase)
  }, [scenarioKey, phase])

  useEffect(() => { LayerManager.setLinks(edges, topology?.nodes ?? []) }, [edges, topology])
  useEffect(() => { LayerManager.setTargets(targets, selectedTargetId ?? undefined) }, [targets, selectedTargetId])
  useEffect(() => { LayerManager.setGroups(groups) }, [groups])
  useEffect(() => { LayerManager.setUavs(uavs) }, [uavs])
  useEffect(() => { LayerManager.setTrack(track) }, [track])

  return null
}
