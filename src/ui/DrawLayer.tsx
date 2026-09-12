// map-2d · 交互层：手绘 / 图元编辑 / 量算（需求 M2-DRAW-08、12、14 / M2-CTRL-10）
//
// 设计（见《设计文档》§10.6）：
//   · 只做"事件 → 坐标 → 调用 MapDraw"，**不碰渲染层**；写入统一走 MapDraw，
//     因此画出来的东西照样能用 export() 存档、hide() 隐藏、被事件命中。
//   · 预览（正在画的线/面、顶点手柄、吸附提示）用**独立的临时源**渲染，
//     不进入图元集合——半成品不该出现在 list()/export() 里。
//   · 吸附用屏幕像素阈值换算成米后判定（视觉上"靠近就吸住"）。
import React, { useEffect, useRef } from 'react'
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl'
import { mapInstance, layersReady } from '../core/instance'
import { MapDraw, type PrimitiveKind } from '../primitives/api'
import {
  bearingDeg, distanceMeters, fmtArea, fmtDistance, insertVertex, isEditableShape,
  pathLengthMeters, polygonAreaM2, pointToSegmentMeters, removeVertex, snapTo, verticesOf, withVertices,
  type LngLat,
} from '../core/geometry'
import { DEFAULT_KIND, isDrawing, useInteraction, type DrawKind } from '../core/interaction'

const PREVIEW_SRC = 'src-2d-interaction'
const LYR_PREVIEW_LINE = 'lyr-2d-preview-line'
const LYR_PREVIEW_FILL = 'lyr-2d-preview-fill'
const LYR_PREVIEW_VERTEX = 'lyr-2d-preview-vertex'
const LYR_PREVIEW_SNAP = 'lyr-2d-preview-snap'

/** 吸附判定阈值（屏幕像素） */
const SNAP_PX = 10
/** 顶点手柄半径（像素） */
const HANDLE_R = 5

const emptyFC = () => ({ type: 'FeatureCollection' as const, features: [] as GeoJSON.Feature[] })
const pt = (p: LngLat, props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: p },
})
const line = (pts: LngLat[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts },
})
const poly = (pts: LngLat[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: 'Feature', properties: props,
  geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] },
})

/** 按当前缩放把屏幕像素阈值换算成米（用于吸附判定） */
function pxToMeters(map: MlMap, px: number): number {
  const lat = map.getCenter().lat
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom())
  return mpp * px
}

/** 收集"可吸附的候选点"：所有已有图元的顶点 */
function snapCandidates(exclude?: { kind: PrimitiveKind; id: string }): { point: LngLat; label?: string }[] {
  const kinds: PrimitiveKind[] = ['area', 'drone', 'target', 'link', 'track', 'scan', 'cluster', 'label', 'route', 'shape']
  const out: { point: LngLat; label?: string }[] = []
  for (const k of kinds) {
    for (const item of MapDraw.list(k) as unknown as Record<string, unknown>[]) {
      if (exclude && exclude.kind === k && exclude.id === item.id) continue
      for (const v of verticesOf(k, item)) {
        if (Number.isFinite(v[0]) && Number.isFinite(v[1])) out.push({ point: v, label: `${k}:${String(item.id)}` })
      }
    }
  }
  return out
}

export const DrawLayer: React.FC = () => {
  const bootRef = useRef(false)

  useEffect(() => {
    // 地图可能还没 load（图层未建立）→ 轮询等待，而不是只试一次
    let timer = 0
    let cleanup: (() => void) | null = null

    const boot = () => {
      const map = mapInstance.current
      if (!map || !layersReady.current) {
        timer = window.setTimeout(boot, 80)
        return
      }
      if (bootRef.current) return
      bootRef.current = true
      cleanup = setup(map)
    }

    timer = window.setTimeout(boot, 0)
    return () => {
      window.clearTimeout(timer)
      cleanup?.()
      bootRef.current = false
    }
  }, [])

  return <InteractionOverlay />
}

/** 建立预览源/图层与全部交互事件；返回清理函数 */
function setup(map: MlMap): () => void {
  {
    if (!map.getSource(PREVIEW_SRC)) {
      map.addSource(PREVIEW_SRC, { type: 'geojson', data: emptyFC() as never })
    }
    if (!map.getLayer(LYR_PREVIEW_FILL)) {
      map.addLayer({
        id: LYR_PREVIEW_FILL, type: 'fill', source: PREVIEW_SRC,
        filter: ['==', ['get', 'role'], 'preview-area'],
        paint: { 'fill-color': '#22d3ee', 'fill-opacity': 0.12 },
      })
    }
    if (!map.getLayer(LYR_PREVIEW_LINE)) {
      map.addLayer({
        id: LYR_PREVIEW_LINE, type: 'line', source: PREVIEW_SRC,
        filter: ['in', ['get', 'role'], ['literal', ['preview-line', 'preview-area', 'edit-edge']]],
        paint: { 'line-color': '#22d3ee', 'line-width': 1.6, 'line-dasharray': [5, 3] },
      })
    }
    if (!map.getLayer(LYR_PREVIEW_VERTEX)) {
      map.addLayer({
        id: LYR_PREVIEW_VERTEX, type: 'circle', source: PREVIEW_SRC,
        filter: ['==', ['get', 'role'], 'vertex'],
        paint: {
          'circle-radius': HANDLE_R,
          'circle-color': ['case', ['==', ['get', 'active'], true], '#22d3ee', '#0b1a2c'],
          'circle-stroke-color': '#22d3ee', 'circle-stroke-width': 1.6,
        },
      })
    }
    if (!map.getLayer(LYR_PREVIEW_SNAP)) {
      map.addLayer({
        id: LYR_PREVIEW_SNAP, type: 'circle', source: PREVIEW_SRC,
        filter: ['==', ['get', 'role'], 'snap'],
        paint: {
          'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 2,
        },
      })
    }

    const setPreview = (features: GeoJSON.Feature[]) => {
      const src = map.getSource(PREVIEW_SRC) as maplibregl.GeoJSONSource | undefined
      src?.setData({ type: 'FeatureCollection', features } as never)
    }

    /** 当前编辑目标的顶点（读取时现算，避免状态里存两份） */
    const editVertices = (): LngLat[] => {
      const { edit } = useInteraction.getState()
      if (!edit) return []
      const item = (MapDraw.list(edit.kind) as unknown as Record<string, unknown>[]).find((x) => x.id === edit.id)
      return item ? verticesOf(edit.kind, item) : []
    }

    /** 重画预览：已落顶点 + 正在编辑的顶点手柄 + 吸附提示 */
    const refresh = () => {
      const st = useInteraction.getState()
      const feats: GeoJSON.Feature[] = []
      const pts = st.points

      if (pts.length) {
        if (st.mode === 'area' || st.mode === 'measure-area') {
          if (pts.length >= 3) feats.push(poly(pts, { role: 'preview-area' }))
          feats.push(line(pts.length >= 2 ? [...pts, pts[0]] : pts, { role: 'preview-area' }))
        } else {
          feats.push(line(pts, { role: 'preview-line' }))
        }
        pts.forEach((p, i) => feats.push(pt(p, { role: 'vertex', active: i === pts.length - 1 })))
      }

      if (st.edit) {
        const ed = st.edit
        const vs = editVertices()
        if (vs.length > 1 && isEditableShape(ed.kind)) {
          const ring = (ed.kind === 'area' && vs.length >= 3) ? [...vs, vs[0]] : vs
          feats.push(line(ring, { role: 'edit-edge' }))
        }
        vs.forEach((v, i) => feats.push(pt(v, { role: 'vertex', active: ed.dragging === i })))
      }

      if (st.snapHint) feats.push(pt(st.snapHint.point, { role: 'snap' }))
      setPreview(feats)
    }

    /** 把测量结果写进交互状态 */
    const updateMeasurement = (pts: LngLat[], mode: 'line' | 'area') => {
      if (pts.length < 2) { useInteraction.getState().setMeasurement(null); return }
      if (mode === 'line') {
        useInteraction.getState().setMeasurement({
          mode, points: pts, meters: pathLengthMeters(pts),
          bearing: pts.length >= 2 ? bearingDeg(pts[0], pts[pts.length - 1]) : undefined,
        })
      } else {
        useInteraction.getState().setMeasurement({
          mode, points: pts, areaM2: pts.length >= 3 ? polygonAreaM2(pts) : 0,
          meters: pathLengthMeters([...pts, pts[0]]),
        })
      }
    }

    /** 完成绘制 → 写入 MapDraw（半成品不进集合） */
    const finishDraw = () => {
      const st = useInteraction.getState()
      const pts = st.points
      if (!pts.length) { useInteraction.getState().reset(); refresh(); return }
      const mode = st.mode
      const kind: DrawKind = st.kind ?? DEFAULT_KIND[mode as keyof typeof DEFAULT_KIND]

      if (mode === 'measure-line' || mode === 'measure-area') {
        updateMeasurement(pts, mode === 'measure-area' ? 'area' : 'line')
        // 量算结果保留在状态里供宿主读取；顶点清空但预览保留测量线
        useInteraction.getState().setPoints([])
        useInteraction.getState().setMode('none')
        setPreview(pts.length >= 2
          ? [mode === 'measure-area' && pts.length >= 3
              ? poly(pts, { role: 'preview-area' })
              : line(pts, { role: 'preview-line' }),
             ...pts.map((p) => pt(p, { role: 'vertex' }))]
          : [])
        return
      }

      const id = `draw-${kind}-${Date.now().toString(36)}`
      if (mode === 'point') {
        MapDraw.add('label', { id, lng: pts[0][0], lat: pts[0][1], text: '新标注', radius: 4, size: 11 } as never)
      } else if (mode === 'area') {
        if (pts.length < 3) { useInteraction.getState().setHint('面至少需要 3 个点'); return }
        MapDraw.add('area', { id, polygon: pts, label: '新区域' } as never)
      } else {
        if (pts.length < 2) { useInteraction.getState().setHint('线至少需要 2 个点'); return }
        MapDraw.add('route', { id, points: pts, dashed: true, color: '#22d3ee', name: '新航线' } as never)
      }
      useInteraction.getState().reset()
      refresh()
    }

    // ---- 交互事件 ----
    const onClick = (e: MapMouseEvent) => {
      const st = useInteraction.getState()
      if (!isDrawing(st.mode)) return
      const p = st.snapHint ? st.snapHint.point : ([e.lngLat.lng, e.lngLat.lat] as LngLat)
      st.addPoint(p)
      if (st.mode === 'point') { finishDraw(); return }
      refresh()
    }

    const onMove = (e: MapMouseEvent) => {
      const st = useInteraction.getState()
      const cursor = [e.lngLat.lng, e.lngLat.lat] as LngLat

      // 绘制中的吸附 + 预览跟随光标
      if (isDrawing(st.mode)) {
        let hint: { point: LngLat; label?: string } | null = null
        if (st.snapEnabled) {
          const s = snapTo(cursor, snapCandidates(), pxToMeters(map, SNAP_PX))
          hint = s ? { point: s.point, label: s.label } : null
        }
        st.setSnapHint(hint)
        const pts = st.points
        if (pts.length) {
          const preview = [...pts, cursor]
          if (st.mode === 'area' || st.mode === 'measure-area') {
            setPreview([
              ...(preview.length >= 3 ? [poly(preview, { role: 'preview-area' })] : []),
              line([...preview, preview[0]], { role: 'preview-area' }),
              ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
              ...(hint ? [pt(hint.point, { role: 'snap' })] : []),
            ])
          } else {
            setPreview([
              line(preview, { role: 'preview-line' }),
              ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
              ...(hint ? [pt(hint.point, { role: 'snap' })] : []),
            ])
          }
        } else refresh()
        return
      }

      // 编辑中的拖拽
      if (st.edit && st.edit.dragging != null) {
        const vs = editVertices()
        const idx = st.edit.dragging
        if (idx < 0 || idx >= vs.length) return
        vs[idx] = cursor
        const item = (MapDraw.list(st.edit.kind) as unknown as Record<string, unknown>[]).find((x) => x.id === st.edit!.id)
        if (item) {
          MapDraw.add(st.edit.kind, withVertices(st.edit.kind, item, vs) as never)
          const ring = (st.edit.kind === 'area' && vs.length >= 3) ? [...vs, vs[0]] : vs
          setPreview([
            ...(vs.length > 1 ? [line(ring, { role: 'edit-edge' })] : []),
            ...vs.map((v, i) => pt(v, { role: 'vertex', active: i === idx })),
          ])
        }
      }
    }

    // 编辑：按下顶点手柄 → 命中哪个顶点就拖哪个
    const onMouseDown = (e: MapMouseEvent) => {
      const st = useInteraction.getState()
      if (!st.edit) return
      const vs = editVertices()
      const best = snapTo([e.lngLat.lng, e.lngLat.lat], vs.map((p) => ({ point: p })), pxToMeters(map, SNAP_PX))
      if (best) {
        st.setDragging(vs.findIndex((p) => p[0] === best.point[0] && p[1] === best.point[1]))
        map.getCanvas().style.cursor = 'grabbing'
      }
    }

    const onMouseUp = () => {
      const st = useInteraction.getState()
      if (st.edit?.dragging != null) st.setDragging(null)
      if (st.edit) map.getCanvas().style.cursor = 'pointer'
    }

    const onDblClick = (e: MapMouseEvent) => {
      const st = useInteraction.getState()
      if (!isDrawing(st.mode) || st.mode === 'point') return
      e.preventDefault()
      finishDraw()
    }

    const onKey = (e: KeyboardEvent) => {
      const st = useInteraction.getState()
      if (e.key === 'Escape') {
        st.reset()
        setPreview([])
        map.getCanvas().style.cursor = ''
        return
      }
      if (e.key === 'Enter' && isDrawing(st.mode)) finishDraw()
      if ((e.key === 'Backspace' || e.key === 'Delete') && st.points.length) {
        st.setPoints(st.points.slice(0, -1))
        refresh()
      }
      // 键盘平移/缩放（M2-CTRL-14 的一部分）：不影响输入框
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const step = e.shiftKey ? 4 : 1
      if (e.key === 'ArrowLeft') map.panBy([-60 * step, 0], { duration: 120 })
      else if (e.key === 'ArrowRight') map.panBy([60 * step, 0], { duration: 120 })
      else if (e.key === 'ArrowUp') map.panBy([0, -60 * step], { duration: 120 })
      else if (e.key === 'ArrowDown') map.panBy([0, 60 * step], { duration: 120 })
      else if (e.key === '+' || e.key === '=') map.zoomTo(map.getZoom() + 1, { duration: 150 })
      else if (e.key === '-' || e.key === '_') map.zoomTo(map.getZoom() - 1, { duration: 150 })
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('mousedown', onMouseDown)
    map.on('mouseup', onMouseUp)
    map.on('dblclick', onDblClick)
    window.addEventListener('keydown', onKey)

    // 有模式/编辑目标变化时同步光标与提示
    const unsub = useInteraction.subscribe((st) => {
      if (isDrawing(st.mode)) {
        map.getCanvas().style.cursor = 'crosshair'
        map.dragPan.disable()          // 绘制时左键用于落点，禁用拖拽平移
      } else {
        map.dragPan.enable()
        map.getCanvas().style.cursor = st.edit ? 'pointer' : ''
        if (!st.edit && !st.points.length) setPreview([])
      }
      if (!isDrawing(st.mode) && !st.edit) refresh()
    })

    refresh()

    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('mousedown', onMouseDown)
      map.off('mouseup', onMouseUp)
      map.off('dblclick', onDblClick)
      window.removeEventListener('keydown', onKey)
      unsub()
      map.dragPan.enable()
    }
  }
}

/** 交互提示浮层：绘制中显示"点数 + 量算结果 + 操作说明" */
const InteractionOverlay: React.FC = () => {
  const mode = useInteraction((s) => s.mode)
  const points = useInteraction((s) => s.points)
  const measurement = useInteraction((s) => s.measurement)
  const edit = useInteraction((s) => s.edit)
  const hint = useInteraction((s) => s.hint)
  const snapHint = useInteraction((s) => s.snapHint)

  if (mode === 'none' && !measurement && !edit && !hint) return null

  const modeText: Record<string, string> = {
    point: '落点绘制（单击即完成）',
    line: '折线绘制',
    area: '面绘制',
    'measure-line': '测距',
    'measure-area': '测面',
  }
  const steps: string[] = []
  if (isDrawing(mode)) {
    steps.push('单击落点', '双击 / Enter 完成', 'Backspace 退一点', 'Esc 取消')
  }

  const live = (() => {
    if (!isDrawing(mode) || points.length < 2) return null
    if (mode === 'measure-area' || mode === 'area') {
      return points.length >= 3 ? `面积 ${fmtArea(polygonAreaM2(points))}｜周长 ${fmtDistance(pathLengthMeters([...points, points[0]]))}` : null
    }
    return `长度 ${fmtDistance(pathLengthMeters(points))}`
  })()

  return (
    <div
      style={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 64, zIndex: 11,
        padding: '7px 12px', borderRadius: 8, maxWidth: 560,
        background: 'rgba(8,16,30,.88)', border: '1px solid var(--panel-border, #1d3a5c)',
        backdropFilter: 'blur(8px)', color: 'var(--text-1, #cfe3f5)', fontSize: 12, lineHeight: 1.5,
        pointerEvents: 'none', textAlign: 'center',
      }}
    >
      {isDrawing(mode) && (
        <div>
          <b style={{ color: '#7fd1ff' }}>{modeText[mode]}</b>
          {points.length > 0 && <span>：已落 {points.length} 点</span>}
          {live && <span style={{ color: '#22d3ee' }}>　{live}</span>}
          <div style={{ color: '#8fb0cc', fontSize: 11 }}>{steps.join('　·　')}</div>
          {snapHint && <div style={{ color: '#f59e0b', fontSize: 11 }}>吸附到 {snapHint.label ?? '已有点'}</div>}
        </div>
      )}
      {!isDrawing(mode) && measurement && (
        <div>
          <b style={{ color: '#7fd1ff' }}>{measurement.mode === 'area' ? '测面' : '测距'}结果</b>
          {measurement.mode === 'line' && (
            <span>：{fmtDistance(measurement.meters ?? 0)}
              {measurement.bearing != null && `　方位角 ${measurement.bearing.toFixed(1)}°`}</span>
          )}
          {measurement.mode === 'area' && (
            <span>：{fmtArea(measurement.areaM2 ?? 0)}　周长 {fmtDistance(measurement.meters ?? 0)}</span>
          )}
          <div style={{ color: '#8fb0cc', fontSize: 11 }}>Esc 清除</div>
        </div>
      )}
      {edit && !isDrawing(mode) && (
        <div>
          <b style={{ color: '#7fd1ff' }}>编辑中</b>：{edit.kind}:{edit.id}
          <span>　拖动顶点手柄即可修改</span>
          <div style={{ color: '#8fb0cc', fontSize: 11 }}>Esc 退出编辑</div>
        </div>
      )}
      {hint && <div style={{ color: '#f59e0b' }}>{hint}</div>}
    </div>
  )
}

/** 供宿主/命令层使用：当前测量结果（null 表示无） */
export function currentMeasurement() {
  return useInteraction.getState().measurement
}

export { distanceMeters }
