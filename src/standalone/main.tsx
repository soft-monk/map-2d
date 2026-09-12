// map-2d · 独立宿主入口
//
// 目标：`npm run dev` 打开即看到地图 + 全部示例图元，不依赖任何后端。
// 界面只有：地图 + 指北针 + 一条极简控制条 + 图层面板（没有左侧导航、没有底部状态栏）。
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Compass, CoordReadout, LayerPanel, MapDraw, MapView, basemaps, mapCommands, useMapUiStore } from '../index'
import type { BasemapDef } from '../index'
import type { MapData } from '../core/types'
import { DEMO_BASEMAPS, DEMO_BASEMAP_DEFS, DEMO_SNAPSHOT } from './demo-data'
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

/** 控件按需显示的演示项（M2-CTRL-01 ~ 05） */
const CONTROL_LABELS: [import('../index').MapControlKey, string][] = [
  ['compass', '指北针'],
  ['coords', '经纬度'],
  ['zoom', '缩放按钮'],
  ['scale', '比例尺'],
]

// 底图清单交给模块的注册表（M2-BASE-09/10/12）：**在渲染前注册**，这样建图时
// 首屏底图就直接来自注册表，不会先建一次再重建。
basemaps.setList(DEMO_BASEMAP_DEFS)

const App: React.FC = () => {
  const [basemapList, setBasemapList] = React.useState<BasemapDef[]>(() => basemaps.list())
  const config = DEMO_BASEMAPS.local.config
  const data = React.useMemo<MapData>(() => ({ ...BASE_DATA, config }), [config])

  // 订阅切换通知：宿主据此同步自己的下拉框（模块负责整幅替换与状态保持）
  React.useEffect(() => basemaps.onChange((def) => {
    setBasemapList(basemaps.list())
    console.info('[demo] 底图已切换 →', def?.id ?? '(无)')
  }), [])

  const currentBasemapId = basemapList.find((b) => b.isCurrent)?.id ?? ''

  const layersOpen = useMapUiStore((s) => s.layersOpen)
  const toggleLayersPanel = useMapUiStore((s) => s.toggleLayersPanel)
  const clearMode = useMapUiStore((s) => s.clearMode)
  const toggleClearMode = useMapUiStore((s) => s.toggleClearMode)
  const controls = useMapUiStore((s) => s.controls)

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
              value={currentBasemapId}
              onChange={(e) => mapCommands.switchBasemap(e.target.value)}
              style={{ ...barButton, paddingRight: 6 }}
              title="底图切换（整幅替换）：由模块 basemaps 注册表驱动"
            >
              {basemapList.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
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

            {/* 控件按需显示（M2-CTRL-01 ~ 05）：四项默认不显示，这里用勾选框演示按需开启 */}
            <span style={{ fontSize: 11.5, color: 'var(--text-2, #8fb0cc)', marginLeft: 6 }}>控件：</span>
            {CONTROL_LABELS.map(([key, label]) => (
              <label key={key} style={{ ...barButton, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={controls[key]}
                  onChange={(e) => mapCommands.showControls([key], e.target.checked)}
                  style={{ margin: 0 }}
                />
                {label}
              </label>
            ))}

            <span style={{ fontSize: 11.5, color: 'var(--text-2, #8fb0cc)', marginLeft: 4 }}>
              {drawn ? `已绘制 ${MapDraw.list('area').length + MapDraw.list('drone').length + MapDraw.list('target').length + MapDraw.list('link').length + MapDraw.list('track').length + MapDraw.list('scan').length + MapDraw.list('pulse').length + MapDraw.list('cluster').length + MapDraw.list('label').length} 个图元` : '未绘制图元'}
            </span>
          </div>
        )}

        {layersOpen && !clearMode && <LayerPanel />}
        {/* 指北针与经纬度读数都受 controls 开关控制（默认都不显示） */}
        <Compass />
        <CoordReadout />
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
