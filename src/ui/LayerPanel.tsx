// map-2d · 图层开关面板（可独立使用，MapToolbar 与独立宿主共用）
import React from 'react'
import { LAYER_GROUP_LABELS, LayerManager } from '../render/LayerManager'
import { LAYER_GROUPS, useMapUiStore } from '../core/store'

export const LayerPanel: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const hiddenGroups = useMapUiStore((s) => s.hiddenGroups)
  const toggleGroup = useMapUiStore((s) => s.toggleGroup)

  return (
    <div style={{
      position: 'absolute', top: 74, left: 12, zIndex: 9, width: 176, padding: '10px 12px',
      background: 'rgba(8,16,30,.92)', border: '1px solid var(--panel-border, #1d3a5c)',
      borderRadius: 8, backdropFilter: 'blur(8px)', fontSize: 12, ...style,
    }}>
      <div style={{ marginBottom: 6, color: 'var(--text-2, #8fb0cc)' }}>图层开关</div>
      {LAYER_GROUPS.map((g) => {
        const on = !hiddenGroups.includes(g)
        return (
          <label key={g} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={on} onChange={() => toggleGroup(g)} />
            <span style={{ color: on ? 'var(--text-1, #cfe3f5)' : 'var(--text-2, #8fb0cc)' }}>{LAYER_GROUP_LABELS[g]}</span>
          </label>
        )
      })}
      <button
        onClick={() => {
          LayerManager.hiddenGroups().forEach((g) => LayerManager.setGroupVisible(g, true))
          useMapUiStore.setState({ hiddenGroups: [] })
        }}
        style={{
          marginTop: 6, width: '100%', padding: '4px 0', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
          background: 'transparent', color: 'var(--cyan, #22d3ee)',
          border: '1px solid var(--panel-border, #1d3a5c)', borderRadius: 6,
        }}
      >全部显示</button>
    </div>
  )
}
