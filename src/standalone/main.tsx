// map-2d · 独立宿主入口
//
// 目标：`npm run dev` 打开即看到地图 + 全部示例图元，不依赖任何后端。
// 界面只有：地图 + 指北针 + 一条极简控制条 + 图层面板（没有左侧导航、没有底部状态栏）。
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import {
  Compass, LayerPanel, MapDraw, MapView, MAP_OPTIONS, mapCommands,
  preloadEstimate, preloadWorldTiles, useMapUiStore,
} from '../index'
import type { MapData } from '../core/types'
import { DEMO_BASEMAPS, DEMO_SNAPSHOT } from './demo-data'
import './standalone.css'

const BASE_DATA: Omit<MapData, 'config'> = {
  scenarioKey: 'demo',
  phase: 'T0',
  targets: [],
  groups: [],
  uavs: [],
  edges: [],
  topology: null,
  track: [],
}

const barButton: React.CSSProperties = {
  padding: '5px 11px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', borderRadius: 6,
  background: 'rgba(10,20,36,.78)', border: '1px solid var(--panel-border, #1d3a5c)',
  color: 'var(--text-1, #cfe3f5)', backdropFilter: 'blur(6px)',
}

const App: React.FC = () => {
  const [basemap, setBasemap] = React.useState<keyof typeof DEMO_BASEMAPS>('local')
  const config = DEMO_BASEMAPS[basemap].config
  const data = React.useMemo<MapData>(() => ({ ...BASE_DATA, config }), [config])

  const layersOpen = useMapUiStore((s) => s.layersOpen)
  const toggleLayersPanel = useMapUiStore((s) => s.toggleLayersPanel)
  const clearMode = useMapUiStore((s) => s.clearMode)
  const toggleClearMode = useMapUiStore((s) => s.toggleClearMode)

  const [drawn, setDrawn] = React.useState(false)

  // 全球低精度"地板层"预热（见 core/preload.ts）
  //   ① 进入页面后自动跑一次（可被 MAP_OPTIONS.preloadOnEnter 关掉）
  //   ② 按钮可手动重跑 / 换底图后重跑；按钮文字即进度（341 张 ≈ 0.3 s）
  // 关键：template 用的是**相对路径**（`/tiles/...`），与地图请求同 origin —— HTTP 缓存按
  // origin 分桶，预热与地图必须同源，否则白白灌一遍另一只桶。在线底图（styleUrl）没有本地
  // 瓦片模板，此时跳过预热。
  const [warm, setWarm] = React.useState<{ running: boolean; done: number; total: number; ms: number } | null>(null)
  const warmRef = React.useRef(false)

  const warmup = React.useCallback(() => {
    const template = config.basemap.tileUrlTemplate
    if (!template || warmRef.current) return
    const maxZoom = MAP_OPTIONS.preloadMaxZoom
    if (maxZoom <= 0) return
    warmRef.current = true
    const { total } = preloadEstimate(maxZoom)
    setWarm({ running: true, done: 0, total, ms: 0 })
    void preloadWorldTiles({
      template,
      maxZoom,
      concurrency: MAP_OPTIONS.preloadConcurrency,
      onProgress: (p) => setWarm({ running: true, done: p.done, total: p.total, ms: 0 }),
    })
      .then((r) => setWarm({ running: false, done: r.ok, total: r.total, ms: r.ms }))
      .finally(() => { warmRef.current = false })
  }, [config])

  // 自动预热：等地图首屏瓦片先抢到连接，再灌地板层
  React.useEffect(() => {
    if (!MAP_OPTIONS.preloadOnEnter) return
    const timer = window.setTimeout(warmup, MAP_OPTIONS.preloadAutoDelayMs)
    return () => window.clearTimeout(timer)
  }, [warmup])

  // 等地图就绪后载入示例图元（不依赖后端数据）
  React.useEffect(() => {
    let timer = 0
    const tick = () => {
      if (mapCommands.isReady()) {
        MapDraw.load(DEMO_SNAPSHOT)
        setDrawn(true)
      } else {
        timer = window.setTimeout(tick, 80)
      }
    }
    tick()
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <MapView data={data}>
        {/* 极简控制条：底图切换 / 示例图元 / 图层 / 清屏 / 复位 */}
        {!clearMode && (
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={basemap}
              onChange={(e) => setBasemap(e.target.value as keyof typeof DEMO_BASEMAPS)}
              style={{ ...barButton, paddingRight: 6 }}
            >
              {Object.entries(DEMO_BASEMAPS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>

            <button style={barButton} onClick={() => { MapDraw.load(DEMO_SNAPSHOT); setDrawn(true) }}>
              载入示例图元
            </button>
            <button style={barButton} onClick={warmup} disabled={warm?.running}>
              {warm
                ? (warm.running
                    ? `预热中 ${warm.done}/${warm.total}`
                    : `预热完成 ${warm.done}/${warm.total} · ${warm.ms} ms`)
                : `预热全球底图 z0–${MAP_OPTIONS.preloadMaxZoom}`}
            </button>
            <button style={barButton} onClick={() => { MapDraw.clear(); setDrawn(false) }}>
              清空图元
            </button>
            <button style={barButton} onClick={toggleLayersPanel}>
              图层{layersOpen ? ' ▲' : ' ▼'}
            </button>
            <button style={barButton} onClick={toggleClearMode}>清屏</button>
            <button style={barButton} onClick={() => mapCommands.resetView(config)}>复位视角</button>

            <span style={{ fontSize: 11.5, color: 'var(--text-2, #8fb0cc)', marginLeft: 4 }}>
              {drawn ? `已绘制 ${MapDraw.list('area').length + MapDraw.list('drone').length + MapDraw.list('target').length + MapDraw.list('link').length + MapDraw.list('track').length + MapDraw.list('scan').length + MapDraw.list('pulse').length + MapDraw.list('cluster').length + MapDraw.list('label').length} 个图元` : '未绘制图元'}
            </span>
          </div>
        )}

        {layersOpen && !clearMode && <LayerPanel />}
        <Compass />
      </MapView>

      {clearMode && (
        <button
          style={{ ...barButton, position: 'absolute', top: 12, right: 66, zIndex: 12 }}
          onClick={toggleClearMode}
        >退出清屏 (Esc)</button>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
