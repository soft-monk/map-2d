// mission-app · map-2d · src/ui/TextOverlay.tsx
//
// **绑定到图元的文本框** —— 用户第 3 条：
//   "每个绘制的可视化图元，都需要有可以绑定几种文本框的方式，帮助人看文本框就知道该图元是什么"。
//
// 为什么用 **HTML 浮层**而不是 MapLibre 的 `symbol` 图层：
//   · `symbol` 只有 `text-halo`（描边），**没有"文字底色块"** —— 画不出真正的"文本框"
//   · 底色块 / 圆角 / 内边距 / 引线这些版式诉求，HTML 一行 CSS 就够，canvas 里要配 9-patch 图
//   · 跟随地图用 `map.project()` 把经纬度换算成屏幕坐标，平移缩放时重算即可（与瓦片渲染同帧）
//
// 设计要点：
//   · **绑定关系在模块里**：`draw-api` 的 `textBindings` 存 `{ ownerKind, ownerId }`，
//     所以"图元被隐藏 → 文本框跟着不显示""图元被删 → 文本框一起没"都是模块自己保证的，
//     宿主不需要维护第二条图元。
//   · 三种样式见 `TEXT_STYLES`：角标 / 卡片 / 引线标注。
import React, { useEffect, useRef, useState } from 'react'
import { mapInstance } from '../core/instance'
import { MapDraw, type PrimitiveKind } from '../primitives/api'
import { textBindingsOf, type TextBinding } from '../primitives/draw-api'

/** 一个文本框在屏幕上的落点 */
interface Placed extends TextBinding {
  x: number
  y: number
}

/** 取图元的"锚点"（点类用自身坐标；面/线类用顶点平均） */
function anchorOf(kind: PrimitiveKind, item: Record<string, unknown>): { lng: number; lat: number } | null {
  const lng = item.lng as number | undefined
  const lat = item.lat as number | undefined
  if (typeof lng === 'number' && typeof lat === 'number') return { lng, lat }
  const pts = (item.polygon ?? item.points ?? []) as [number, number][]
  if (pts.length) {
    const sx = pts.reduce((s, p) => s + p[0], 0)
    const sy = pts.reduce((s, p) => s + p[1], 0)
    return { lng: sx / pts.length, lat: sy / pts.length }
  }
  const from = item.from as [number, number] | undefined
  const to = item.to as [number, number] | undefined
  if (from && to) return { lng: (from[0] + to[0]) / 2, lat: (from[1] + to[1]) / 2 }
  return null
}

/**
 * 文本框浮层。**挂在 `<MapView>` 里**（跟 `CoordReadout` / `DrawLayer` 同一层）。
 *
 * 它自己订阅 `MapDraw.on('change')` —— 图元增删改/显隐一变就重算，**不轮询**。
 */
export const TextOverlay: React.FC = () => {
  const [placed, setPlaced] = useState<Placed[]>([])
  const raf = useRef(0)

  useEffect(() => {
    const compute = () => {
      const map = mapInstance.current
      if (!map) { setPlaced([]); return }
      const out: Placed[] = []
      for (const b of textBindingsOf()) {
        // 绑定的图元必须还在、而且**可见** —— 图元隐藏时文本框一起隐藏（联动）
        const items = MapDraw.list(b.ownerKind) as unknown as Record<string, unknown>[]
        const item = items.find((x) => x.id === b.ownerId)
        if (!item) continue
        if (item.visible === false) continue
        const a = anchorOf(b.ownerKind, item)
        if (!a) continue
        const p = map.project([a.lng, a.lat] as never)
        out.push({ ...b, x: p.x, y: p.y })
      }
      setPlaced(out)
    }

    // 地图平移/缩放/旋转时重算（rAF 合并，避免每帧 setState 多次）
    const schedule = () => {
      if (raf.current) return
      raf.current = requestAnimationFrame(() => { raf.current = 0; compute() })
    }

    const map = mapInstance.current
    compute()
    if (map) {
      map.on('move', schedule)
      map.on('zoom', schedule)
      map.on('rotate', schedule)
    }
    const off = MapDraw.on('change', schedule)
    return () => {
      off()
      if (raf.current) cancelAnimationFrame(raf.current)
      if (map) { map.off('move', schedule); map.off('zoom', schedule); map.off('rotate', schedule) }
    }
  }, [])

  if (!placed.length) return null
  return (
    <>
      {placed.map((t) => (
        <Box key={t.id} t={t} />
      ))}
    </>
  )
}

/** 三种样式各自的画法 */
const Box: React.FC<{ t: Placed }> = ({ t }) => {
  const base: React.CSSProperties = {
    position: 'absolute', zIndex: 8, pointerEvents: 'none',
    fontFamily: 'inherit', color: '#eaf6ff', whiteSpace: 'nowrap',
  }
  if (t.style === 'card') {
    // 卡片：标题 + 正文（正文按「 · 」切，演示够用；信息量大时比角标好读）
    const [title, ...rest] = t.text.split('·').map((s) => s.trim())
    return (
      <div data-map2d-text={t.id} data-text-style="card" style={{
        ...base, left: t.x + 10, top: t.y - 12, minWidth: 96,
        background: 'rgba(6,26,47,.92)', border: '1px solid rgba(95,176,255,.55)',
        borderRadius: 6, padding: '4px 8px', boxShadow: '0 2px 10px rgba(0,0,0,.45)',
      }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{title}</div>
        {rest.length > 0 && <div style={{ fontSize: 11, color: '#9fc4e6', marginTop: 2 }}>{rest.join(' · ')}</div>}
      </div>
    )
  }
  if (t.style === 'callout') {
    // 引线标注：从图元拉一条短引线到文字块
    return (
      <div data-map2d-text={t.id} data-text-style="callout" style={{ ...base, left: t.x, top: t.y }}>
        <svg width="46" height="30" style={{ position: 'absolute', left: 0, top: -4, overflow: 'visible' }}>
          <line x1="0" y1="0" x2="42" y2="-14" stroke="rgba(160,200,235,.75)" strokeWidth="1" />
        </svg>
        <div style={{
          position: 'absolute', left: 42, top: -24,
          background: 'rgba(6,26,47,.9)', border: '1px solid rgba(95,176,255,.45)',
          borderRadius: 4, padding: '2px 7px', fontSize: 11.5,
        }}>{t.text}</div>
      </div>
    )
  }
  // 缺省：角标（一行小字贴着图元）
  return (
    <div data-map2d-text={t.id} data-text-style="tag" style={{
      ...base, left: t.x + 8, top: t.y - 18,
      background: 'rgba(6,26,47,.82)', border: '1px solid rgba(95,176,255,.45)',
      borderRadius: 4, padding: '1px 6px', fontSize: 11.5,
    }}>{t.text}</div>
  )
}
