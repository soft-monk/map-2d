// 地图模块 · 地图工具条（含指北针以外的全部地图级控件）
//
// 工具（CAND-MAP-02 / 契约 §9.1）：选择、测距、图层、区域、新建、清屏、全屏、标绘
//   - 选择 / 图层 / 清屏 / 全屏：已实现
//   - 测距 / 区域 / 新建 / 标绘：界面占位（disabled，状态见《地图相关需求专篇》CAND-MAP-02）
// 设计：模块自带内联图标与样式，不依赖应用的 UI 组件库，便于整模块移植。
import React from 'react'
import { LayerManager } from '../render/LayerManager'
import { useMapUiStore } from '../core/store'
import { LayerPanel } from './LayerPanel'
import type { MapToolKey } from '../core/types'

const TOOLS: { key: MapToolKey; label: string; ready: boolean; hint?: string }[] = [
  { key: 'select', label: '选择', ready: true },
  { key: 'measure', label: '测距', ready: false, hint: '待实现（CAND-MAP-02）' },
  { key: 'layer', label: '图层', ready: true },
  { key: 'area', label: '区域', ready: false, hint: '待实现（CAND-MAP-02）' },
  { key: 'new', label: '新建', ready: false, hint: '待实现（CAND-MAP-02）' },
  { key: 'clear', label: '清屏', ready: true },
  { key: 'full', label: '全屏', ready: true },
  { key: 'draw', label: '标绘', ready: false, hint: '待实现（CAND-MAP-02）' },
]

/** 极简内联图标（避免依赖应用 UI 组件库） */
const Glyph: React.FC<{ k: MapToolKey }> = ({ k }) => {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const
  switch (k) {
    case 'select': return <svg {...common}><path d="M3 2l10 5-4 1.4L7.6 13z" /></svg>
    case 'measure': return <svg {...common}><path d="M2 11l9-9 3 3-9 9z" /><path d="M5 8l1.6 1.6M7.5 5.5L9 7" /></svg>
    case 'layer': return <svg {...common}><path d="M8 2l6 3.5L8 9 2 5.5z" /><path d="M2 9.5L8 13l6-3.5" /></svg>
    case 'area': return <svg {...common}><path d="M2.5 4.5l5-2 6 3-1 6-6 2-4-3z" /></svg>
    case 'new': return <svg {...common}><path d="M8 2v12M2 8h12" /></svg>
    case 'clear': return <svg {...common}><path d="M2 3h12v10H2z" opacity=".45" /><path d="M6 6l4 4M10 6l-4 4" /></svg>
    case 'full': return <svg {...common}><path d="M2 6V2h4M14 10v4h-4M14 6V2h-4M2 10v4h4" /></svg>
    case 'draw': return <svg {...common}><path d="M2 13c3-6 6-9 12-11" /><circle cx="13.5" cy="2.5" r="1.3" /></svg>
  }
}

export const MapToolbar: React.FC = () => {
  const { activeTool, setActiveTool, layersOpen, toggleLayersPanel, setLayersPanel, clearMode, toggleClearMode } = useMapUiStore()

  const onTool = (key: MapToolKey) => {
    setActiveTool(key)
    if (key === 'layer') toggleLayersPanel()
    else if (key !== 'select') setLayersPanel(false)

    if (key === 'clear') { toggleClearMode(); return }
    if (key === 'full') {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => undefined)
    }
  }

  return (
    <>
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 6, zIndex: 9 }}>
        {TOOLS.map((t) => {
          const isClear = t.key === 'clear'
          const active = isClear ? clearMode : activeTool === t.key
          return (
            <button
              key={t.key}
              disabled={!t.ready}
              title={t.ready ? t.label : `${t.label}：${t.hint}`}
              onClick={() => t.ready && onTool(t.key)}
              style={{
                padding: '6px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                fontSize: 10.5, fontFamily: 'inherit', borderRadius: 6,
                cursor: t.ready ? 'pointer' : 'not-allowed',
                opacity: t.ready ? 1 : 0.4,
                background: 'rgba(8,16,30,.72)', backdropFilter: 'blur(6px)',
                border: `1px solid ${active ? 'var(--cyan, #22d3ee)' : 'var(--panel-border, #1d3a5c)'}`,
                color: active ? 'var(--cyan, #22d3ee)' : 'var(--text-1, #cfe3f5)',
              }}
            >
              <Glyph k={t.key} />
              {t.label}
            </button>
          )
        })}
      </div>

      {layersOpen && !clearMode && <LayerPanel />}
    </>
  )
}

/** 显示模式徽标（右上角，随阶段变化；清屏时隐藏） */
export const MapModeBadge: React.FC<{ mode: string }> = ({ mode }) => {
  const clearMode = useMapUiStore((s) => s.clearMode)
  if (clearMode || !mode) return null
  return (
    <div style={{
      position: 'absolute', top: 12, right: 68, padding: '7px 14px', fontSize: 12.5, zIndex: 9,
      display: 'flex', alignItems: 'center', gap: 8, borderRadius: 8,
      background: 'rgba(8,16,30,.72)', border: '1px solid var(--panel-border, #1d3a5c)', backdropFilter: 'blur(6px)',
    }}>
      <span style={{ color: 'var(--text-2, #8fb0cc)' }}>显示模式：</span>
      <b style={{ color: 'var(--cyan, #22d3ee)' }}>{mode}</b>
    </div>
  )
}
