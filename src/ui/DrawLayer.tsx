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
  pathLengthMeters, polygonAreaM2, pointToSegmentMeters, nearestWithin, removeVertex, verticesOf, withVertices,
  type LngLat,
} from '../core/geometry'
import { DEFAULT_KIND, isDrawing, useInteraction, type DrawKind } from '../core/interaction'
import { draw } from '../primitives/draw-api'

const PREVIEW_SRC = 'src-2d-interaction'
const LYR_PREVIEW_LINE = 'lyr-2d-preview-line'
const LYR_PREVIEW_FILL = 'lyr-2d-preview-fill'
const LYR_PREVIEW_VERTEX = 'lyr-2d-preview-vertex'

// 顶点手柄的命中半径（原 `SNAP_PX` —— 吸附删掉后只剩"按下的是哪个手柄"这一个用途，名字改准）
const HANDLE_PX = 10
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

/** 按当前缩放把屏幕像素阈值换算成米（用于顶点手柄的命中判定） */
function pxToMeters(map: MlMap, px: number): number {
  const lat = map.getCenter().lat
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom())
  return mpp * px
}

// ★ 2026-09-18：这里原先还有一个 `snapCandidates()` —— 收集全图所有图元的顶点当"吸附候选"。
//   用户说吸附没必要，**整条链路已删**（候选收集 / 吸附判定 / 吸附标记 / 「吸附到 …」提示）。
//   现在光标落哪儿就是哪儿。

/**
 * 圆/椭圆的**预览环**（48 边形近似）。
 * 预览只要"看着是个圈"，用不着真圆 —— 正式绘制由 `draw.circle` 交给 `shape` 图元渲染。
 */
function circlePreview(center: LngLat, radiusKm: number, ellipse: boolean): GeoJSON.Feature {
  const dLat = (radiusKm * 1000 / 6371008.8) * (180 / Math.PI)
  const dLng = dLat / Math.max(1e-6, Math.cos((center[1] * Math.PI) / 180))
  const ring: [number, number][] = []
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2
    ring.push([center[0] + Math.cos(a) * dLng, center[1] + Math.sin(a) * dLat * (ellipse ? 0.5 : 1)])
  }
  return poly(ring, { role: 'preview-area' })
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
    // ★ 2026-09-18：吸附预览图层（`lyr-2d-preview-snap`）已整条删除 —— 用户："吸附没必要"。

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

    /**
     * **几何原语的"多点类"收笔**（折线 / 闭合线 / 真面）—— 双击或 Enter 触发。
     * 少点就按每种的最小点数拦住并给提示（**不静默丢**）。
     */
    const finishGeo = () => {
      const st = useInteraction.getState()
      const g = st.geo
      if (!g) return
      const pts = st.points.map((p) => [p[0], p[1]] as [number, number])
      const common = { color: g.color, widthPx: g.widthPx, dashed: g.dashed, text: g.text, textStyle: g.textStyle }
      let id: string | null = null
      if (g.key === 'line') {
        if (pts.length < 2) { st.setHint('线至少需要 2 个点'); return }
        id = draw.line({ points: pts, ...common })
      } else if (g.key === 'closedLine') {
        if (pts.length < 3) { st.setHint('闭合线至少需要 3 个点'); return }
        id = draw.closedLine({ points: pts, ...common })
      } else if (g.key === 'polygon') {
        if (pts.length < 3) { st.setHint('面至少需要 3 个点'); return }
        id = draw.polygon({ ring: pts, fillColor: g.fillColor, fillOpacity: g.fillOpacity, strokeWidthPx: g.widthPx, dashed: g.dashed, text: g.text, textStyle: g.textStyle })
      }
      if (id) g.onDone?.(id)
      st.setGeometry(null)
      setPreview([])
      refresh()
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
      const p = [e.lngLat.lng, e.lngLat.lat] as LngLat   // 落点就是光标位置（吸附已删）

      // ★ 2026-09-18：**几何原语绘制**（点/线/闭合线/真面/圆/椭圆）—— 落点语义由模块自己处理，
      //   宿主只用 `mapCommands.setGeometry(key)` 起一次，不再自己写"两下点出半径"的状态机。
      if (st.geo) {
        const key = st.geo.key
        const two = key === 'circle' || key === 'ellipse'
        /** 收口：交回宿主 / 按几何原语造 / 什么都不造，三处共用一个出口 */
        const done = (id: string | null) => {
          if (id) st.geo?.onDone?.(id)
          st.setGeometry(null)
          refresh()
        }
        // ★ 宿主自定义建法（`make` 钩子）：交互照旧在模块，造什么由宿主决定。
        //   典型用途是业务层的"目标点 / 军标 / 距离环"这类**不是几何原语**的图元。
        const mk = st.geo.make
        if (mk) {
          if (two) {
            if (st.points.length === 0) { st.addPoint(p); refresh(); return }
            const c = st.points[0]
            const rKm = Math.max(0.05, distanceMeters(c, p) / 1000)
            done(mk([{ lng: c[0], lat: c[1] }, { lng: p[0], lat: p[1] }], rKm))
            return
          }
          // 点类：一下就成（多点类在下面继续攒点，等双击/Enter）
          if (key !== 'point') {
            st.addPoint(p)
            refresh()
            return
          }
          done(mk([{ lng: p[0], lat: p[1] }], 0))
          return
        }
        if (key === 'point') {
          const id = draw.point({ lng: p[0], lat: p[1], sizePx: st.geo.sizePx, color: st.geo.color, text: st.geo.text, textStyle: st.geo.textStyle }) as string
          done(id)
          return
        }
        if (two) {
          // 两下：第一下定中心，第二下决定半径（离屏预览在第 1 点与光标之间）
          const pts = st.points
          if (pts.length === 0) { st.addPoint(p); refresh(); return }
          const center = pts[0]
          const radiusKm = Math.max(0.05, distanceMeters(center, p) / 1000)
          const spec = {
            lng: center[0], lat: center[1], radiusKm,
            color: st.geo.color, fillColor: st.geo.fillColor, fillOpacity: st.geo.fillOpacity,
            strokeWidthPx: st.geo.widthPx, dashed: st.geo.dashed,
            text: st.geo.text, textStyle: st.geo.textStyle,
          }
          const id = key === 'circle'
            ? draw.circle(spec) as string
            : draw.ellipse({ ...spec, radiusKmMinor: radiusKm / 2 }) as string
          done(id)
          return
        }
        // 多点类：折线 / 闭合线 / 真面（双击或 Enter 结束）
        st.addPoint(p)
        refresh()
        return
      }

      if (!isDrawing(st.mode)) return
      st.addPoint(p)
      if (st.mode === 'point') { finishDraw(); return }
      refresh()
    }

    const onMove = (e: MapMouseEvent) => {
      const st = useInteraction.getState()
      const cursor = [e.lngLat.lng, e.lngLat.lat] as LngLat

      // 几何原语的多点预览（折线 / 闭合线 / 真面）：与老 mode 用同一套预览图层
      if (st.geo && (st.geo.key === 'line' || st.geo.key === 'closedLine' || st.geo.key === 'polygon')) {
        const pts = st.points
        if (pts.length) {
          const preview = [...pts, cursor]
          const closed = st.geo.key !== 'line'
          setPreview([
            ...(closed && preview.length >= 3 ? [poly(preview, { role: 'preview-area' })] : []),
            line(closed ? [...preview, preview[0]] : preview, { role: closed ? 'preview-area' : 'preview-line' }),
            ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
          ])
        } else refresh()
        return
      }
      // 几何原语的"两下类"（圆 / 椭圆）：第一点已落，画一个橡皮圈预览
      if (st.geo && (st.geo.key === 'circle' || st.geo.key === 'ellipse') && st.points.length) {
        const c = st.points[0]
        const rKm = Math.max(0.05, distanceMeters(c, cursor) / 1000)
        setPreview([
          circlePreview(c, rKm, st.geo.key === 'ellipse'),
          pt(c, { role: 'vertex', active: true }),
        ])
        return
      }

      // 绘制中的预览跟随光标
      // ★ 2026-09-18（用户："点上面有吸附功能？没必要，可以删除该功能"）：**吸附整条链路已删** ——
      //   光标落哪儿就是哪儿，不再吸到已有点、不再画吸附标记、不再弹「吸附到 …」。
      if (isDrawing(st.mode)) {
        const pts = st.points
        if (pts.length) {
          const preview = [...pts, cursor]
          if (st.mode === 'area' || st.mode === 'measure-area') {
            setPreview([
              ...(preview.length >= 3 ? [poly(preview, { role: 'preview-area' })] : []),
              line([...preview, preview[0]], { role: 'preview-area' }),
              ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
            ])
          } else {
            setPreview([
              line(preview, { role: 'preview-line' }),
              ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
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
      const best = nearestWithin([e.lngLat.lng, e.lngLat.lat], vs.map((p) => ({ point: p })), pxToMeters(map, HANDLE_PX))
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
      // 几何原语的"多点类"：双击结束（折线 / 闭合线 / 真面）
      if (st.geo) {
        const key = st.geo.key
        if (key === 'line' || key === 'closedLine' || key === 'polygon') {
          e.preventDefault()
          finishGeo()
        }
        return
      }
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
      if (e.key === 'Enter' && st.geo && (st.geo.key === 'line' || st.geo.key === 'closedLine' || st.geo.key === 'polygon')) finishGeo()
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
      // 几何原语绘制时也用十字光标 + 禁拖拽平移（与老 mode 同款）
      if (st.geo) {
        map.getCanvas().style.cursor = 'crosshair'
        map.dragPan.disable()
        if (!st.points.length) refresh()
        return
      }
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
