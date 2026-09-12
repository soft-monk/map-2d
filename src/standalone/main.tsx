// map-2d · 独立宿主入口
//
// 目标：`npm run dev` 打开即看到地图 + 全部示例图元，不依赖任何后端。
// 界面只有：地图 + 指北针 + 一条极简控制条 + 图层面板（没有左侧导航、没有底部状态栏）。
import React from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import { Compass, CoordReadout, DrawLayer, LayerPanel, Legend, MapDraw, MapView, ReplayBar, basemaps, mapCommands, useMapUiStore } from '../index'
import type { BasemapDef } from '../index'
import type { MapData } from '../core/types'
import { DEMO_BASEMAPS, DEMO_BASEMAP_DEFS, DEMO_REPLAY, DEMO_SNAPSHOT, DEMO_STYLES } from './demo-data'
import { Acceptance } from './acceptance'
import { useInteraction } from '../index'
import './standalone.css'

const BASE_DATA: Omit<MapData, 'config'> = {
  scenarioKey: 'demo',
  // 演示用 T4（无人机/目标/扫描等均可见；回放演示也需要）：阶段规则允许"目标 / 无人机 / 扫描 / 脉冲 / 链路 / 区域 / 航线"同时可见，
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
  // 按钮多了以后 flex 会把它们压扁；这两个属性防止中文被压成"一字一行"
  whiteSpace: 'nowrap', flex: '0 0 auto',
}

/** 绘制/量算按钮：模式、文字、悬浮说明 */
const DRAW_BUTTONS: [import('../index').DrawMode, string, string][] = [
  ['point', '落点', '单击落一个标注点'],
  ['line', '航线', '单击落点，双击 / Enter 完成'],
  ['area', '画区', '单击落点，双击 / Enter 闭合'],
  ['measure-line', '测距', '单击落点，双击 / Enter 结束'],
  ['measure-area', '测面', '单击落点，双击 / Enter 结束'],
]

/** 主题按钮（M2-CTRL-13） */
const THEME_BUTTONS: [import('../index').ThemeKey, string][] = [['day', '日间'], ['night', '夜间'], ['contrast', '高对比']]

/** 13 类图元（用于角标计数） */
const TOTAL_KINDS: import('../index').PrimitiveKind[] = ['area', 'drone', 'target', 'link', 'track', 'scan', 'pulse', 'cluster', 'label', 'route', 'shape', 'annulus', 'symbol']

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
// 登记命名样式模板（M2-DRAW-15）：图元用 style 名引用，改模板即批量生效
mapCommands.setStyleTemplates(DEMO_STYLES)

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
  const theme = useMapUiStore((s) => s.theme)

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
          <div
          style={{
            position: 'absolute', top: 12, left: 12, zIndex: 10,
            display: 'flex', gap: 6, alignItems: 'center',
            flexWrap: 'wrap',                 // 按钮多时换行，而不是被压扁
            maxWidth: 'min(1080px, calc(100% - 340px))',  // 给右侧验收台留位置
            rowGap: 6,
          }}
        >
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
            <button
              style={barButton}
              title="导出当前地图为图片（含已开启的控件）—— M2-API-09"
              onClick={() => void mapCommands.downloadImage()}
            >导出图片</button>
            <button
              style={barButton}
              title="导出当前视图状态到 localStorage —— M2-API-08"
              onClick={() => {
                void mapCommands.exportViewState().then((s) => {
                  localStorage.setItem('map2d-view-state', JSON.stringify(s))
                  window.alert('已保存视图状态（视角/图层开关/控件/底图/图元）\n字段：' + Object.keys(s).join(', '))
                })
              }}
            >保存视角</button>
            <button
              style={barButton}
              title="从 localStorage 恢复视图状态 —— M2-API-08"
              onClick={() => {
                const raw = localStorage.getItem('map2d-view-state')
                if (!raw) { window.alert('还没有保存过视图状态'); return }
                void mapCommands.restoreViewState(JSON.parse(raw)).then((r) => {
                  window.alert(r.ok ? '已恢复：' + r.applied.join('、') : '恢复失败：' + r.reason)
                })
              }}
            >恢复视角</button>

            <button
              style={barButton}
              title="载入 60 秒回放数据（模块给时间轴，数据由宿主提供）—— M2-DRAW-17/18"
              onClick={() => { mapCommands.loadReplay(DEMO_REPLAY); mapCommands.playReplay() }}
            >载入回放</button>
            <button
              style={barButton}
              title="清空回放数据并停止播放 —— M2-DRAW-18"
              onClick={() => mapCommands.clearReplay()}
            >清除回放</button>

            {/* 显示模式（M2-CTRL-09）：手动指定后优先于阶段推导 */}
            <button
              style={barButton}
              title="手动指定显示模式：任务规划（优先于阶段推导）—— M2-CTRL-09"
              onClick={() => { const r = mapCommands.setDisplayMode('任务规划'); window.alert('当前显示模式：' + r.mode + '（手动=' + r.manual + '，阶段推导=' + r.derived + '）') }}
            >手动模式</button>
            <button
              style={barButton}
              title="解除手动覆盖，回落到阶段推导值 —— M2-CTRL-09"
              onClick={() => { const r = mapCommands.clearDisplayMode(); window.alert('已回落：' + r.mode + '（手动=' + r.manual + '）') }}
            >回落模式</button>
            <button
              style={barButton}
              title="载入国军标标绘符号示例（8 个，含敌我框形）—— M2-DRAW-16"
              onClick={() => { MapDraw.set('symbol', DEMO_SNAPSHOT.symbol as never); window.alert('已载入 ' + MapDraw.list('symbol').length + ' 个标绘符号') }}
            >载入符号</button>

            {/* 主题热切换（M2-CTRL-13）：运行中切换，不重建样式、不刷新页面 */}
            <span style={{ fontSize: 11.5, color: 'var(--text-2, #8fb0cc)', marginLeft: 6 }}>主题：</span>
            {THEME_BUTTONS.map(([key, label]) => (
              <button
                key={key}
                title={`切换到${label}主题（M2-CTRL-13）`}
                style={{
                  ...barButton,
                  borderColor: theme === key ? 'var(--cyan, #22d3ee)' : 'var(--panel-border, #1d3a5c)',
                  color: theme === key ? 'var(--cyan, #22d3ee)' : 'var(--text-1, #cfe3f5)',
                }}
                onClick={() => mapCommands.applyTheme(key)}
              >{label}</button>
            ))}

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
              {drawn ? `已绘制 ${TOTAL_KINDS.reduce((n, k) => n + MapDraw.list(k).length, 0)} 个图元（13 类）` : '未绘制图元'}
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
        {/* 回放时间轴：加载了回放数据才显示 */}
        <ReplayBar />
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
