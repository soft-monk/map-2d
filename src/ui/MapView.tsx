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
import { mapInstance, layersReady } from '../core/instance'
import { MAP_OPTIONS } from '../core/options'
import { tileMaxZoomFromOptions } from '../core/tilePrecision'
import { applyControls } from '../core/controls'
import { injectControlStyle, MAP_CONTAINER_CLASS } from '../core/style'
import { reapplyTheme } from '../core/theme'
import { BASEMAP_CHANGE_EVENT, basemaps } from '../core/basemaps'
import { bindPrimitiveEvents } from '../core/primitiveEvents'
import { setPrimitiveCounter, startFpsCounter } from '../core/diagnostics'
import { useMapUiStore } from '../core/store'
import type { MapConfigData, MapData } from '../core/types'

// 视口内暂无任何瓦片时的底色（兜底样式 / 底图尚未出现的第一帧）。
// 取深蓝灰而非近黑：即使出现也会被当成"地面"，不会形成刺眼黑框。
const VOID_BG = '#08111f'

// 底图缺口处的"地面"色。瓦片尚未到达时先露出它，视觉上接近压暗后的影像，
// 避免近黑背景在暗色影像上形成一块明显的黑框。
const GAP_BG = '#16283a'

// 底图瓦片可用到的最大级别；低清全球底图只取到 UNDERLAY_MAX_ZOOM。
const BASE_MAX_ZOOM = 14
const UNDERLAY_MAX_ZOOM = 6

/**
 * 瓦片精度上限 → 允许使用的最大层级（需求 M2-BASE-05 / 决策 D2、D3）。
 * 换算与状态在 core/tilePrecision.ts；这里只做转发，保持 UI 侧引用集中。
 */
export { tileMaxZoomFromOptions } from '../core/tilePrecision'

/** 无瓦片时的兜底样式：纯底，保证任何环境都能打开 */
function fallbackStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': VOID_BG } }],
  }
}

/**
 * 本地栅格底图样式。
 *
 * 防"滑动时露出未加载黑框"的三层结构（自下而上）：
 *   1. bg         —— 缺口底色（深蓝灰，非黑）
 *   2. base-underlay —— 同一瓦片源的低清叠底（只请求 z0–6，全球覆盖）。
 *                       瓦片是四叉树，MapLibre 在 z7+ 时本就会用 z6 父瓦片兜底；
 *                       把 z0–6 常驻成独立图层后，快速拖动时任何新区域都是有图的，
 *                       高清瓦片到达后再无缝替换。
 *   3. base       —— 高清瓦片（z0–14），压暗 + 去饱和的深色指挥风格。
 * 另：两个栅格图层的 raster-fade-duration = MAP_OPTIONS.rasterFadeDuration（默认 0），
 * 瓦片到达即显示、不做淡入，因此"低清叠底 → 高清"的替换是瞬时的，
 * 不会在过渡期露出一层半透明的底色。
 */
function rasterStyle(tileUrl: string, attribution: string): maplibregl.StyleSpecification {
  // 署名是否交给 MapLibre 由 MAP_OPTIONS.showAttribution 决定：
  // 关闭时不写入 source.attribution，避免控件隐藏但样式里仍残留署名文本。
  const attrib = MAP_OPTIONS.showAttribution ? { attribution } : {}
  // 精度上限：两层的 maxzoom 都不超过它（叠底层再单独受 UNDERLAY_MAX_ZOOM 约束）
  const limit = tileMaxZoomFromOptions()
  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: limit,
        ...attrib,
      },
      // 同一 URL 模板：z0–6 请求的就是全球低清瓦片，z7+ 的显示由父瓦片放大提供
      'base-underlay': {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: Math.min(limit, UNDERLAY_MAX_ZOOM),
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': GAP_BG } },
      // 低清叠底：只做轻微压暗去饱和，尽量亮一点 → 高清未到时看起来是"低清影像"而不是"黑框"
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
      // 统一色调（只作用于高清层，叠底保持较亮，缺口才不会被越描越黑）
      { id: 'base-tint', type: 'background', paint: { 'background-color': 'rgba(6, 26, 52, 0.16)' } },
    ],
  }
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
  const setPointer = useMapUiStore((s) => s.setPointer)
  // 精度上限变化时递增，用于触发底图样式重建（见下方 basemapKey）
  const [precisionRev, setPrecisionRev] = useState(0)
  // 底图切换（basemaps.switch）：由 core/basemaps 广播，这里递增同样触发重建
  const [basemapRev, setBasemapRev] = useState(0)
  // 初始化只做一次：用挂载时的配置快照
  const bootRef = useRef<MapData>(data)

  useEffect(() => {
    const onPrecision = () => setPrecisionRev((n) => n + 1)
    const onBasemap = () => setBasemapRev((n) => n + 1)
    window.addEventListener('map2d:tile-precision-change', onPrecision)
    window.addEventListener(BASEMAP_CHANGE_EVENT, onBasemap)
    return () => {
      window.removeEventListener('map2d:tile-precision-change', onPrecision)
      window.removeEventListener(BASEMAP_CHANGE_EVENT, onBasemap)
    }
  }, [])

  useEffect(() => {
    if (!hostRef.current) return
    // 模块控件样式（比例尺/缩放按钮/署名）由模块自己注入，不依赖宿主样式表
    injectControlStyle()
    hostRef.current.classList.add(MAP_CONTAINER_CLASS)
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

    // 控件按需显示（M2-CTRL-01）：默认全不显示，由 MAP_OPTIONS.controls 与 mapCommands 控制
    applyControls(map)

    map.on('load', () => {
      LayerManager.init(map)
      LayerManager.applyVisibility()   // 恢复用户此前的图层开关
      layersReady.current = true       // 图层已建立：此后 MapDraw 的写入才会真正落到源上
      MapDraw.render()                 // 把"建图前就灌进来"的图元一次性补画
      reapplyTheme()                   // 主题热切换（M2-CTRL-13）：新样式上重新套用当前主题
      bindPrimitiveEvents(map)         // 图元点击/悬停回调（M2-DRAW-13）
      startFpsCounter()                // 运行指标（M2-CTRL-15）
      setPrimitiveCounter(() => ({     // 各类图元数量：由绘制 API 的集合统计
        area: MapDraw.list('area').length,
        drone: MapDraw.list('drone').length,
        target: MapDraw.list('target').length,
        link: MapDraw.list('link').length,
        track: MapDraw.list('track').length,
        scan: MapDraw.list('scan').length,
        pulse: MapDraw.list('pulse').length,
        cluster: MapDraw.list('cluster').length,
        label: MapDraw.list('label').length,
        route: MapDraw.list('route').length,
        shape: MapDraw.list('shape').length,
      }))
      setReady(true)
    })

    // 鼠标位置经纬度（coords 控件用；节流后再写状态，避免每像素触发重渲染）
    let lastPointer = 0
    map.on('mousemove', (e) => {
      const now = performance.now()
      if (now - lastPointer < 60) return
      lastPointer = now
      setPointer({ lng: +e.lngLat.lng.toFixed(5), lat: +e.lngLat.lat.toFixed(5) })
    })
    map.getCanvas().addEventListener('mouseleave', () => setPointer(null))

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
      layersReady.current = false
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

  // 底图切换有两条来源：
  //   ① 宿主直接改 config.basemap（本地瓦片 ↔ 在线样式）
  //   ② 调 basemaps.switch(id)（多套本地底图整体替换）——由 core/basemaps 广播触发
  // 精度上限变化（tileMax）也走同一条路径：源 maxzoom 变了必须重建样式
  const activeBasemap = basemaps.current()
  const basemapKey = [
    config?.basemap?.styleUrl ?? '',
    config?.basemap?.tileUrlTemplate ?? '',
    activeBasemap?.id ?? '',
    tileMaxZoomFromOptions(),
  ].join('|')
  const firstBasemapRef = useRef(true)
  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    if (firstBasemapRef.current) { firstBasemapRef.current = false; return }
    // 有注册底图时以注册表的当前项为准（basemaps.switch 的语义就是"整幅替换"）
    const style = activeBasemap ? buildStyle(basemaps.toConfig(activeBasemap, config)) : buildStyle(config)
    map.setStyle(style as never)
    const onStyled = () => {
      // setStyle 会清空所有 source/layer，需要重建并重放绘图 API 的图元
      if (!map.getSource('src-area')) {
        LayerManager.init(map)
        LayerManager.applyVisibility()
      }
      MapDraw.render()
      // 样式重建会把主题相关的 paint 属性（底图亮度/叠加色/标签描边）重置为默认值，
      // 因此必须重新套用当前主题，否则"换底图后主题丢失"（M2-CTRL-13）。
      reapplyTheme()
    }
    map.once('styledata', onStyled)
    // basemapRev 只用于触发重建（值本身不参与比较）
  }, [basemapKey, precisionRev, basemapRev])

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
