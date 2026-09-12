// 地图模块 · 指北针（MAP-01 / CAND-MAP-03 / M2-CTRL-02）
//
// 设计：自绘 SVG（不走 MapLibre 自带控件），因为：
//   1) 二维模式锁定旋转（maxPitch=0、禁 rotate），自带罗盘会被禁用样式；
//   2) 自绘可随 bearing 旋转、可定制配色，且不占用地图控件位。
// 行为：随地图 bearing 反向旋转，始终保持指向正北；点击可复位视角朝向。
//
// 可见性（M2-CTRL-02）：默认**不显示**，由 `controls.compass` 控制——
// 调 mapCommands.showControls(['compass']) 才出现；也可传 `force` 强制显示（宿主自行决定时用）。
import React, { useEffect, useState } from 'react'
import { mapInstance } from '../core/instance'
import { useMapUiStore } from '../core/store'

export const Compass: React.FC<{ size?: number; force?: boolean }> = ({ size = 44, force = false }) => {
  const [bearing, setBearing] = useState(0)
  const setViewport = useMapUiStore((s) => s.setViewport)
  const enabled = useMapUiStore((s) => s.controls.compass)

  useEffect(() => {
    const map = mapInstance.current
    if (!map) return
    const onRotate = () => {
      const b = map.getBearing()
      setBearing(b)
      setViewport({ bearing: b })
    }
    onRotate()
    map.on('rotate', onRotate)
    return () => { map.off('rotate', onRotate) }
  }, [setViewport])

  if (!force && !enabled) return null

  return (
    <div
      data-map2d-compass="true"
      title="指北针：N 始终指向正北；点击复位正北"
      onClick={() => mapInstance.current?.easeTo({ bearing: 0, duration: 300 })}
      style={{
        // 落在缩放按钮（top-right，约 10–62px）正下方，留 16px 间距避免贴住
        position: 'absolute', top: 78, right: 12, width: size, height: size, zIndex: 9,
        borderRadius: '50%', cursor: 'pointer',
        background: 'rgba(8,16,30,.72)', border: '1px solid var(--panel-border, #1d3a5c)',
        backdropFilter: 'blur(6px)', display: 'grid', placeItems: 'center',
      }}
    >
      <svg width={size - 8} height={size - 8} viewBox="0 0 32 32" style={{ transform: `rotate(${-bearing}deg)`, transition: 'transform .12s linear' }}>
        {/* 外圈刻度 */}
        <circle cx="16" cy="16" r="13.5" fill="none" stroke="rgba(120,180,230,.35)" strokeWidth="1" />
        <line x1="16" y1="2.5" x2="16" y2="5" stroke="rgba(160,200,235,.5)" strokeWidth="1" />
        <line x1="16" y1="27" x2="16" y2="29.5" stroke="rgba(160,200,235,.5)" strokeWidth="1" />
        <line x1="2.5" y1="16" x2="5" y2="16" stroke="rgba(160,200,235,.5)" strokeWidth="1" />
        <line x1="27" y1="16" x2="29.5" y2="16" stroke="rgba(160,200,235,.5)" strokeWidth="1" />
        {/* 指针：北红南蓝 */}
        <polygon points="16,4.5 19,17 16,15 13,17" fill="#ef4444" />
        <polygon points="16,27.5 13,15 16,17 19,15" fill="#4a86c8" />
        <circle cx="16" cy="16" r="1.6" fill="#dff3ff" />
      </svg>
      <span style={{
        position: 'absolute', top: -1, fontSize: 9, fontWeight: 700, color: '#ff6b6b', letterSpacing: .5,
      }}>N</span>
    </div>
  )
}
