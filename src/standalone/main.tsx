// map-2d · 独立宿主入口
//
// 目标：`npm run dev` 打开即看到地图 + 全部示例图元，不依赖任何后端。
// 界面只有：地图 + 指北针 + 一条极简控制条 + 图层面板（没有左侧导航、没有底部状态栏）。
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Compass, LayerPanel, MapDraw, MapView, mapCommands, useMapUiStore } from '../index'
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
