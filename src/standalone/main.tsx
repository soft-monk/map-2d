// map-2d · 独立宿主入口
//
// 目标：`npm run dev` 打开即看到地图 + 全部示例图元，不依赖任何后端。
// 界面只有：地图 + 指北针 + 一条极简控制条 + 图层面板（没有左侧导航、没有底部状态栏）。
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Compass, CoordReadout, DrawLayer, LayerPanel, Legend, MapDraw, MapView, basemaps, mapCommands, useMapUiStore } from '../index'
import type { BasemapDef } from '../index'
import type { MapData } from '../core/types'
import { DEMO_BASEMAPS, DEMO_BASEMAP_DEFS, DEMO_SNAPSHOT } from './demo-data'
import { Acceptance } from './acceptance'
import { useInteraction } from '../index'
import './standalone.css'

const BASE_DATA: Omit<MapData, 'config'> = {
  scenarioKey: 'demo',
  // 演示用 T4：此时阶段规则允许"目标 / 无人机 / 扫描 / 脉冲 / 链路 / 区域 / 航线"同时可见，
  // 才能一次看全 11 类图元。T0–T2 按阶段规则不显示目标与无人机（这是设计如此，不是缺陷）。
  phase: 'T4',
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

/** 绘制/量算按钮：模式、文字、悬浮说明 */
const DRAW_BUTTONS: [import('../index').DrawMode, string, string][] = [
  ['point', '落点', '单击落一个标注点'],
  ['line', '航线', '单击落点，双击 / Enter 完成'],
  ['area', '画区', '单击落点，双击 / Enter 闭合'],
  ['measure-line', '测距', '单击落点，双击 / Enter 结束'],
  ['measure-area', '测面', '单击落点，双击 / Enter 结束'],
]

/** 11 类图元（用于角标计数） */
const TOTAL_KINDS: import('../index').PrimitiveKind[] = ['area', 'drone', 'target', 'link', 'track', 'scan', 'pulse', 'cluster', 'label', 'route', 'shape']

/** 控件按需显示的演示项（M2-CTRL-01 ~ 05） */
const CONTROL_LABELS: [import('../index').MapControlKey, string][] = [
  ['compass', '指北针'],
  ['coords', '经纬度'],
  ['zoom', '缩放按钮'],
  ['scale', '比例尺'],
  ['legend', '图例'],
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
  const drawMode = useInteraction((s) => s.mode)

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

            {/* 绘制与量算（M2-DRAW-08 / M2-CTRL-10）：与工具条同一套能力，这里做成按钮组 */}
            <span style={{ fontSize: 11.5, color: 'var(--text-2, #8fb0cc)', marginLeft: 6 }}>绘制：</span>
            {DRAW_BUTTONS.map(([mode, label, hint]) => (
              <button
                key={mode}
                title={hint}
                style={{
                  ...barButton,
                  borderColor: drawMode === mode ? 'var(--cyan, #22d3ee)' : 'var(--panel-border, #1d3a5c)',
                  color: drawMode === mode ? 'var(--cyan, #22d3ee)' : 'var(--text-1, #cfe3f5)',
                }}
                onClick={() => mapCommands.setDrawMode(drawMode === mode ? 'none' : mode)}
              >
                {label}
              </button>
            ))}

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
              {drawn ? `已绘制 ${TOTAL_KINDS.reduce((n, k) => n + MapDraw.list(k).length, 0)} 个图元（11 类）` : '未绘制图元'}
            </span>
          </div>
        )}

        {layersOpen && !clearMode && <LayerPanel />}
        {/* 指北针与经纬度读数都受 controls 开关控制（默认都不显示） */}
        <Compass />
        <CoordReadout />
        <Legend />
        {/* 交互层：手绘 / 编辑 / 量算 */}
        <DrawLayer />
        {/* 功能验收台：已完成能力做成可点按钮，待完成项只读展示（需求完成情况一览） */}
        {!clearMode && <Acceptance />}
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
