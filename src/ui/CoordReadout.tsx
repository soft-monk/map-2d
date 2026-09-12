// map-2d · 鼠标位置经纬度控件（需求 M2-CTRL-03）
//
// 自绘组件（不依赖宿主 UI 库）：读取模块 UI 状态里的 pointer（由 MapView 的 mousemove 节流回写）。
// 是否显示由 controls.coords 控制——默认不显示，调 mapCommands.showControls(['coords']) 才出现。
import React from 'react'
import { useMapUiStore } from '../core/store'

/** 十进制经纬度 → 度分秒（便于指挥场景读数） */
function dms(v: number, isLat: boolean): string {
  const hemi = isLat ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W'
  const abs = Math.abs(v)
  const d = Math.floor(abs)
  const mFloat = (abs - d) * 60
  const m = Math.floor(mFloat)
  const s = Math.round((mFloat - m) * 60)
  return `${hemi}${d}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″`
}

export const CoordReadout: React.FC<{ dmsFormat?: boolean; style?: React.CSSProperties }> = ({
  dmsFormat = false,
  style,
}) => {
  const visible = useMapUiStore((s) => s.controls.coords)
  const pointer = useMapUiStore((s) => s.pointer)
  if (!visible) return null

  const text = pointer
    ? dmsFormat
      ? `${dms(pointer.lat, true)}  ${dms(pointer.lng, false)}`
      : `${pointer.lng.toFixed(5)}, ${pointer.lat.toFixed(5)}`
    : '移动鼠标查看经纬度'

  return (
    <div
      style={{
        position: 'absolute', left: 12, bottom: 12, zIndex: 9,
        padding: '6px 10px', fontSize: 12, fontFamily: 'Consolas, monospace',
        background: 'rgba(8,16,30,.72)', border: '1px solid var(--panel-border, #1d3a5c)',
        borderRadius: 6, color: 'var(--text-1, #cfe3f5)', backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {text}
    </div>
  )
}
