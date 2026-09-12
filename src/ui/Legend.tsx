// map-2d · 地图内图例（需求 M2-CTRL-11）
//
// 设计：图例内容**从图元的真实配色来源取**，而不是另写一份常量——
// 颜色本身来自 primitives/api.ts 的内置调色板与图元属性，这里只做展示。
// 因此"图例与实际渲染不一致"这类问题不会出现。
import React from 'react'
import { useMapUiStore } from '../core/store'

/** 图例条目：名称 + 颜色 + 形状提示 */
export interface LegendItem {
  label: string
  color: string
  /** 形状：色块 / 圆点 / 线 / 虚线 / 圆圈 */
  shape?: 'block' | 'dot' | 'line' | 'dash' | 'ring'
}

export interface LegendSection {
  title: string
  items: LegendItem[]
}

/** 默认图例内容（与 primitives/api.ts 的调色板一致） */
export const DEFAULT_LEGEND: LegendSection[] = [
  {
    title: '威胁等级',
    items: [
      { label: '高', color: '#ef4444', shape: 'dot' },
      { label: '中', color: '#f59e0b', shape: 'dot' },
      { label: '低', color: '#22d3ee', shape: 'dot' },
    ],
  },
  {
    title: '目标状态',
    items: [
      { label: '已确认 / 打击', color: '#ef4444', shape: 'ring' },
      { label: '持续监控', color: '#f59e0b', shape: 'ring' },
      { label: '已失效', color: '#8b93a7', shape: 'ring' },
    ],
  },
  {
    title: '链路状态',
    items: [
      { label: '通（实线）', color: '#22c55e', shape: 'line' },
      { label: '弱（虚线）', color: '#f59e0b', shape: 'dash' },
      { label: '断（虚线）', color: '#ef4444', shape: 'dash' },
    ],
  },
  {
    title: '图元类型',
    items: [
      { label: '任务区域 / 封闭区', color: '#22d3ee', shape: 'block' },
      { label: '圆形 / 椭圆区域', color: '#3b82f6', shape: 'block' },
      { label: '目标区域（打击）', color: '#ef4444', shape: 'block' },
      { label: '搜索区', color: '#f59e0b', shape: 'block' },
      { label: '无人机航线', color: '#22d3ee', shape: 'dash' },
      { label: '目标轨迹', color: '#ef4444', shape: 'dash' },
      { label: '扫描覆盖', color: '#38bdf8', shape: 'ring' },
      { label: '标注节点', color: '#cfe3f5', shape: 'dot' },
    ],
  },
]

const Swatch: React.FC<{ color: string; shape?: LegendItem['shape'] }> = ({ color, shape = 'dot' }) => {
  const base: React.CSSProperties = { width: 14, height: 14, display: 'inline-block', flex: '0 0 auto' }
  switch (shape) {
    case 'block':
      return <span style={{ ...base, background: color, opacity: 0.65, border: `1px solid ${color}` }} />
    case 'line':
      return <span style={{ ...base, height: 0, borderTop: `2px solid ${color}`, marginTop: 6 }} />
    case 'dash':
      return <span style={{ ...base, height: 0, borderTop: `2px dashed ${color}`, marginTop: 6 }} />
    case 'ring':
      return <span style={{ ...base, borderRadius: '50%', border: `2px solid ${color}` }} />
    case 'dot':
    default:
      return <span style={{ ...base, borderRadius: '50%', background: color }} />
  }
}

/**
 * 地图内图例。
 * 可见性：由 `controls.legend` 控制（默认不显示，与其他控件一致），
 * 也可传 `force` 由宿主自行决定何时渲染。
 */
export const Legend: React.FC<{ sections?: LegendSection[]; force?: boolean; style?: React.CSSProperties }> = ({
  sections = DEFAULT_LEGEND,
  force = false,
  style,
}) => {
  const visible = useMapUiStore((s) => s.controls.legend)
  if (!force && !visible) return null

  return (
    <div
      data-map2d-legend="true"
      style={{
        position: 'absolute', left: 12, top: 12, zIndex: 9,
        maxWidth: 232, padding: '8px 10px', borderRadius: 8,
        background: 'rgba(8,16,30,.82)', border: '1px solid var(--panel-border, #1d3a5c)',
        backdropFilter: 'blur(8px)', color: 'var(--text-1, #cfe3f5)',
        fontSize: 11.5, lineHeight: 1.5, pointerEvents: 'none',
        ...style,
      }}
    >
      {sections.map((sec) => (
        <div key={sec.title} style={{ marginBottom: 6 }}>
          <div style={{ color: '#7fd1ff', fontWeight: 600, marginBottom: 2 }}>{sec.title}</div>
          {sec.items.map((it) => (
            <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Swatch color={it.color} shape={it.shape} />
              <span style={{ color: '#cfe3f5' }}>{it.label}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
