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
import { DEFAULT_KIND, isDrawing, useInteraction, type DrawKind, type GeometryRequest } from '../core/interaction'
import {
  draftNow, moveDraftVertex, useGeometryDraft, type GeometryDraft,
} from '../core/draft'
import { shapePreviewNow, useShapePreview, type ShapePreview } from '../core/shapePreview'
import { bearingRingTicks, circleRing, gridLines } from '../core/annulus'
import { draw, rotateGeometry } from '../primitives/draw-api'

const PREVIEW_SRC = 'src-2d-interaction'
const LYR_PREVIEW_LINE = 'lyr-2d-preview-line'
const LYR_PREVIEW_FILL = 'lyr-2d-preview-fill'
const LYR_PREVIEW_VERTEX = 'lyr-2d-preview-vertex'
const LYR_PREVIEW_SNAP = 'lyr-2d-preview-snap'

// 顶点手柄的命中半径（原 `SNAP_PX` —— 吸附删掉后只剩"按下的是哪个手柄"这一个用途，名字改准）
/** 吸附判定阈值（屏幕像素） 2026-09-20 按需求恢复吸附（历史：9-18 曾整条删除，当时这里被改名为 HANDLE_PX） */
const SNAP_PX = 10
const HANDLE_PX = 10
/** 顶点手柄半径（像素） */
const HANDLE_R = 5

/**
 * **走"草稿 → 合并框 → 确认"这条路的几何种类**（2026-09-21 新增）。
 *
 * 需求原话："点线面绘制的时候…绘制完成后弹标签 + 经纬度编辑框，合并为一起，点击确认后绘制"。
 * 圆 / 椭圆不在名单里 —— 它们是"两下：中心 → 尺寸"，本轮需求没点名，仍旧收笔即落图。
 */
const DRAFT_KEYS: string[] = ['point', 'line', 'closedLine', 'polygon']

/**
 * **编辑态按 `R` 一次转多少度**（2026-09-21 需求方定："按一次 R 转 15°（逆时针）"）。
 * 只一个方向（需求方："不需要反向，就一个方向"）。改这个数即可调步长。
 */
const ROTATE_STEP_DEG = 15

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

/**
 * **收集"可吸附的候选点"**：全图所有图元的顶点（可排除某个图元  拖它自己时别吸到自己）。
 * 2026-09-20 按需求恢复（历史：2026-09-18 随吸附一起删过）。
 */
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
    // 吸附标记层（2026-09-20 按需求恢复）：光标附近有可吸附点时画一个琥珀色圈
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

    /**
     * **把"已画的点"交出去变成草稿**（2026-09-21 新增）。
     * 这一路之后 `MapDraw` 里**什么都没有**，图上画的是预览；宿主弹框、改完再 `commit()`。
     */
    const hostDone = (g: GeometryRequest, pts: LngLat[], _radiusKm = 0) => {
      useGeometryDraft.getState().begin({
        kind: g.key,
        points: pts,
        label: g.text ?? '',
        textStyle: g.textStyle ?? 'tag',
        color: g.color, widthPx: g.widthPx, sizePx: g.sizePx, dashed: g.dashed,
        fillColor: g.fillColor, fillOpacity: g.fillOpacity,
        make: g.make,
      })
      // 收笔：交互状态清干净（顶点已进草稿），提示态也收掉 —— 框自己会说明接下来干什么
      useInteraction.getState().setGeometry(null)
      useInteraction.getState().setHintMode('none')
      setPreview([])
    }

    /** 草稿的预览要素：线 / 闭环 / 面 + 每顶点一个手柄（含"编辑手柄亮着"这条需求） */
    const draftFeatures = (d: GeometryDraft): GeoJSON.Feature[] => {
      const pts = d.points
      if (!pts.length) return []
      const handles = pts.map((v, i) => pt(v, { role: 'vertex', active: i === pts.length - 1 }))
      if (d.kind === 'point') return handles
      if (d.kind === 'polygon' || d.kind === 'closedLine') {
        const closed = pts.length >= 3 ? [...pts, pts[0]] : pts
        return [
          ...(d.kind === 'polygon' && pts.length >= 3 ? [poly(pts, { role: 'preview-area' })] : []),
          line(closed, { role: 'preview-line' }),
          ...handles,
        ]
      }
      return [line(pts, { role: 'preview-line' }), ...handles]
    }

    /** 重画预览：已落顶点 + 正在编辑的顶点手柄 + 吸附提示 */
    const refresh = () => {
      const st = useInteraction.getState()
      const feats: GeoJSON.Feature[] = []
      const pts = st.points

      // ★ 2026-09-21：**草稿态**（收笔后、确认前）优先 —— 画的是草稿的顶点（框里改数字、拖手柄都会到这里）。
      //   草稿与"绘制中"互斥：进草稿时交互状态已经清干净了。
      const d = draftNow()
      if (d) {
        setPreview(draftFeatures(d))
        return
      }

      // ★ 2026-09-21：**形状预览**（"指定尺寸模式"的实时预览：中心 + 尺寸 → 虚线青色）。
      //   与草稿并列的第二条通道，见 core/shapePreview.ts 的说明（两条互不影响）。
      const sp = shapePreviewNow()
      if (sp) {
        setPreview(shapePreviewFeatures(sp))
        return
      }

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

      // 吸附标记（2026-09-20 恢复）
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
      const p = st.snapHint ? st.snapHint.point : ([e.lngLat.lng, e.lngLat.lat] as LngLat)   // 有吸附就用吸附点

      // ★ 2026-09-21：**点 / 线 / 闭合线 / 面 不再"收笔即落图"，改为产出一份草稿**。
      //   目的（需求原话）："绘制完成后弹标签 + 经纬度合并框，**点击确认后才绘制**" ——
      //   所以这一路只调 `hostDone`：由宿主决定弹框、改完再确认；本层只画预览。
      //   圆 / 椭圆仍走老路（收笔即落图）—— 本轮需求只点名点 / 线 / 面。
      if (DRAFT_KEYS.includes(st.geo?.key as string)) {
        const g = st.geo!
        const two = g.key === 'circle' || g.key === 'ellipse'
        /** 草稿出口：把"已落的点"交出去，图上只留预览 */
        const toDraft = () => {
          const pts = st.points.map((q) => [q[0], q[1]] as LngLat)
          if (g.key === 'line' || g.key === 'closedLine') {
            if (pts.length < 2) { st.setHint('线至少需要 2 个点'); return }
          } else if (g.key === 'polygon') {
            if (pts.length < 3) { st.setHint('面至少需要 3 个点'); return }
          }
          hostDone(g, pts)
        }
        const mk = g.make
        if (mk) {
          if (two) {
            if (st.points.length === 0) { st.addPoint(p); refresh(); return }
            const c = st.points[0]
            const rKm = Math.max(0.05, distanceMeters(c, p) / 1000)
            hostDone(g, [[c[0], c[1]], [p[0], p[1]]], rKm)
            return
          }
          if (g.key !== 'point') { st.addPoint(p); refresh(); return }
          hostDone(g, [[p[0], p[1]] as LngLat])
          return
        }
        if (g.key === 'point') { hostDone(g, [[p[0], p[1]] as LngLat]); return }
        st.addPoint(p)
        refresh()
        return
      }

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

      // ★ 2026-09-21：**草稿态**（收笔后、确认前）—— 框开着的时候也算"编辑手柄亮着"，
      //   所以在图上按住草稿的某个手柄就能拖它：拖完写回草稿 → 预览 + 宿主框里的数字一起变。
      //   注意草稿**不在 `MapDraw` 里**，所以不能走下面那条"读图元 → withVertices → 写回"的老路。
      const draft = draftNow()
      if (draft) {
        const cur2 = [e.lngLat.lng, e.lngLat.lat] as LngLat
        if (draftDragIdx !== null) {
          moveDraftVertex(draftDragIdx, cur2)
          return
        }
        const hit = nearestWithin(cur2, draft.points.map((q) => ({ point: q })), pxToMeters(map, HANDLE_PX))
        map.getCanvas().style.cursor = hit ? 'grab' : ''
        if (st.snapHint) st.setSnapHint(null)
        return
      }

      // 绘制中的预览跟随光标
      // 2026-09-20：**吸附恢复**（历史：9-18 按需求删过） 光标附近有可吸附点就吸住它、
      //   画琥珀色标记，并把提示写进 snapHint（落点 onClick 用它）。
      if (isDrawing(st.mode)) {
        const pts = st.points
        const snap = st.snapEnabled ? nearestWithin(cursor, snapCandidates(), pxToMeters(map, SNAP_PX)) : null
        st.setSnapHint(snap ? { point: snap.point, label: snap.label } : null)
        const snapFeat = snap ? [pt(snap.point, { role: 'snap' })] : []
        if (pts.length) {
          const preview = [...pts, cursor]
          if (st.mode === 'area' || st.mode === 'measure-area') {
            setPreview([
              ...(preview.length >= 3 ? [poly(preview, { role: 'preview-area' })] : []),
              line([...preview, preview[0]], { role: 'preview-area' }),
              ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
              ...snapFeat,
            ])
          } else {
            setPreview([
              line(preview, { role: 'preview-line' }),
              ...pts.map((p, i) => pt(p, { role: 'vertex', active: i === pts.length - 1 })),
              ...snapFeat,
            ])
          }
        } else refresh()
        return
      }

      // 编辑中的拖拽： 单顶点（含吸附） 整块移动（dragging === -1）
      if (st.edit && st.edit.dragging != null) {
        const vs = editVertices()
        const idx = st.edit.dragging
        const item = (MapDraw.list(st.edit.kind) as unknown as Record<string, unknown>[]).find((x) => x.id === st.edit!.id)
        if (!item) return
        if (idx === -1) {
          // ---- 拖整块（2026-09-20 需求 B 新增）：按"按下那一刻的顶点"整体平移 ----
          if (!dragOrigin || !dragBase) return
          const dlng = cursor[0] - dragOrigin[0]
          const dlat = cursor[1] - dragOrigin[1]
          const moved = dragBase.map(([x, y]) => [x + dlng, y + dlat] as LngLat)
          MapDraw.add(st.edit.kind, withVertices(st.edit.kind, item, moved) as never)
          const ring = (st.edit.kind === 'area' && moved.length >= 3) ? [...moved, moved[0]] : moved
          setPreview([
            ...(moved.length > 1 ? [line(ring, { role: 'edit-edge' })] : []),
            ...moved.map((v) => pt(v, { role: 'vertex' })),
          ])
          return
        }
        if (idx < 0 || idx >= vs.length) return
        // 单顶点：先吸附（排除正在编辑的这条，别吸到自己）
        const snap = st.snapEnabled ? nearestWithin(cursor, snapCandidates(st.edit), pxToMeters(map, SNAP_PX)) : null
        st.setSnapHint(snap ? { point: snap.point, label: snap.label } : null)
        vs[idx] = snap ? snap.point : cursor
        MapDraw.add(st.edit.kind, withVertices(st.edit.kind, item, vs) as never)
        const ring = (st.edit.kind === 'area' && vs.length >= 3) ? [...vs, vs[0]] : vs
        setPreview([
          ...(vs.length > 1 ? [line(ring, { role: 'edit-edge' })] : []),
          ...vs.map((v, i) => pt(v, { role: 'vertex', active: i === idx })),
          ...(snap ? [pt(snap.point, { role: 'snap' })] : []),
        ])
        return
      }

      // 不在绘制/拖拽时把吸附提示清掉（免得标记留在屏幕上）
      if (st.snapHint) st.setSnapHint(null)
    }

    /** 整块拖动的起点（按下时的经纬度）与"按下那一刻的顶点"（2026-09-20 新增） */
    let dragOrigin: LngLat | null = null
    let dragBase: LngLat[] | null = null

    /**
     * 草稿态正在拖第几个顶点（null = 没在拖；2026-09-21 新增）。
     * 与下面 `dragOrigin/dragBase` 是两套：那套拖的是**已落库的图元**，这套拖的是**还没落库的草稿**。
     */
    let draftDragIdx: number | null = null

    // 编辑：按在手柄上就拖那个顶点；按在图元身上就拖整块移动
    const onMouseDown = (e: MapMouseEvent) => {
      const st = useInteraction.getState()

      // ★ 2026-09-21：草稿态先判 —— 按在草稿顶点手柄上就开始拖它（草稿不在 MapDraw 里，走另一套）
      const d = draftNow()
      if (d) {
        const cur: LngLat = [e.lngLat.lng, e.lngLat.lat]
        const hit = nearestWithin(cur, d.points.map((q) => ({ point: q })), pxToMeters(map, HANDLE_PX))
        if (hit) {
          draftDragIdx = d.points.findIndex((q) => q[0] === hit.point[0] && q[1] === hit.point[1])
          map.getCanvas().style.cursor = 'grabbing'
        }
        return
      }

      if (!st.edit) return
      const cur: LngLat = [e.lngLat.lng, e.lngLat.lat]
      const vs = editVertices()
      const best = nearestWithin(cur, vs.map((p) => ({ point: p })), pxToMeters(map, HANDLE_PX))
      if (best) {
        st.setDragging(vs.findIndex((p) => p[0] === best.point[0] && p[1] === best.point[1]))
        map.getCanvas().style.cursor = 'grabbing'
        return
      }
      // 没按在手柄上：判"是否按在这个图元身上"（点：离点的距离；线/面：离任一线段的距离）
      const item = (MapDraw.list(st.edit.kind) as unknown as Record<string, unknown>[]).find((x) => x.id === st.edit!.id)
      if (!item) return
      const thM = pxToMeters(map, HANDLE_PX)
      const onBody = vs.length === 1
        ? distanceMeters(vs[0], cur) <= thM
        : vs.some((v, i) => pointToSegmentMeters(cur, v, vs[(i + 1) % vs.length]) <= thM)
      if (onBody) {
        dragOrigin = cur
        dragBase = vs.map((p) => [p[0], p[1]] as LngLat)
        st.setDragging(-1)
        map.getCanvas().style.cursor = 'grabbing'
      }
    }

    const onMouseUp = () => {
      const st = useInteraction.getState()
      dragOrigin = null
      dragBase = null
      // 草稿顶点拖拽的收尾（2026-09-21）：松手就结束，坐标已经写回草稿
      if (draftDragIdx !== null) {
        draftDragIdx = null
        map.getCanvas().style.cursor = ''
      }
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
      // ★ 2026-09-21：**草稿态时本层一律不抢键盘** —— Esc / Enter 都由宿主的合并框处理
      //   （Esc = 放弃绘制；Enter = 确定）。否则 `st.reset()` 只清交互状态、清不掉草稿，
      //   会出现"框还开着、图上的预览已经被清掉"的分裂状态。
      if (draftNow()) return
      if (e.key === 'Escape') {
        st.reset()
        setPreview([])
        map.getCanvas().style.cursor = ''
        return
      }
      if (e.key === 'Enter' && st.geo && (st.geo.key === 'line' || st.geo.key === 'closedLine' || st.geo.key === 'polygon')) finishGeo()
      if (e.key === 'Enter' && isDrawing(st.mode)) finishDraw()
      // ★ 2026-09-21 新需求：**编辑态按 `R` 把选中的区域逆时针转 15°**（需求方："选中状态后支持按键 r"）。
      //   范围（需求方点名）：只有**区域（面）**要转；点 / 线 / 航线 / 距离环 / 方位圈 / 九宫格都不转。
      //   实现落在模块：`rotateGeometry(id, deg)` 按外接框中心整体转顶点再写回 —— 宿主不必知道
      //   "顶点存在哪个字段、面要不要闭合"。转完 `refresh()` 让顶点手柄与新位置对齐。
      //   ⚠️ 必须先排掉"正在输入框里打字"：本监听挂在 window 上，输入框里的 r 也会冒到这里
      //   （在合并框里改标注名称时按 r 就会被吃掉）。所以这里自己判一次 target，不依赖下面的通用判断。
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement | null)?.tagName ?? '')
      if (!inField && (e.key === 'r' || e.key === 'R') && st.edit) {
        if (rotateGeometry(st.edit.id, ROTATE_STEP_DEG)) refresh()
        return
      }
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
        // 2026-09-20：编辑态里「正在拖手柄 / 拖整块」时**禁用地图拖拽**，否则拖图元会把地图一起拖走
        if (st.edit?.dragging != null) map.dragPan.disable()
        map.getCanvas().style.cursor = st.edit ? (st.edit.dragging != null ? 'grabbing' : 'pointer') : ''
        // 2026-09-20：进/出编辑态也要重画，否则"点图元进编辑"时**顶点手柄不显示**
        //   （旧逻辑只在 `!st.edit` 时才 refresh，编辑态恰恰被跳过）
        if (st.edit) refresh()
        else if (!st.points.length) setPreview([])
      }
      if (!isDrawing(st.mode) && !st.edit) refresh()
    })

    // ★ 2026-09-21：**草稿一变就重画预览**。草稿既可能被宿主改（框里改数字 / 加行 / 删行），
    //   也可能被本层改（拖草稿顶点）—— 两边都走这份订阅，预览与框里的数字因此永远一致。
    //   确认（commit）/ 放弃（discard）后草稿变 null，这里顺手把预览清掉，图上不留痕。
    const unsubDraft = useGeometryDraft.subscribe((s) => {
      if (!s.draft) setPreview([])
      else refresh()
    })

    // ★ 2026-09-21：**形状预览一变就重画**（宿主改中心/尺寸、或确定/取消时清空都走这条）。
    //   与草稿那条订阅并列、互不干扰：清了形状预览若还有草稿，`refresh()` 会把草稿画回来。
    const unsubShape = useShapePreview.subscribe((s) => {
      if (!s.preview) setPreview([])
      else refresh()
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
      unsubDraft()
      unsubShape()
      map.dragPan.enable()
    }
  }
}

/**
 * **形状预览 → 预览图层的要素**（2026-09-21 新增："指定尺寸模式"的实时预览）。
 *
 * 只画**虚线**（`preview-line` 那一路）—— 与草稿的线同款；**不画填充**：
 * 这几类形状（距离环 / 方位圈 / 九宫格）本身就是线状几何，实心色块会把底图糊住。
 * 几何生成**复用模块自己的函数**（`circleRing` / `bearingRingTicks` / `gridLines`），
 * 所以预览与最终画出来的图元**同源**，不会"预览一个样、落图另一个样"。
 */
function shapePreviewFeatures(p: ShapePreview): GeoJSON.Feature[] {
  const center: LngLat = [p.center[0], p.center[1]]
  const out: GeoJSON.Feature[] = []
  if (p.kind === 'rect') {
    // 矩形：中心 + 半宽/半高 → 闭合环（虚线）。经纬度换算与宿主的 `rectRing` 同一口径
    const halfW = p.halfWkm ?? 0
    const halfH = p.halfHkm ?? 0
    if (halfW > 0 && halfH > 0) {
      const cosLat = Math.max(1e-6, Math.cos((center[1] * Math.PI) / 180))
      const dLng = halfW / (111.32 * cosLat)
      const dLat = halfH / 111.32
      const ring: LngLat[] = [
        [center[0] - dLng, center[1] - dLat],
        [center[0] + dLng, center[1] - dLat],
        [center[0] + dLng, center[1] + dLat],
        [center[0] - dLng, center[1] + dLat],
        [center[0] - dLng, center[1] - dLat],
      ]
      out.push(line(ring, { role: 'preview-line' }))
    }
    return out
  }
  if (p.kind === 'ring' || p.kind === 'bearing-ring') {
    const radii = (p.radiusKmList ?? []).filter((r) => r > 0)
    for (const r of radii) out.push(line(circleRing(center, r), { role: 'preview-line' }))
    if (p.kind === 'bearing-ring') {
      for (const r of radii) {
        for (const t of bearingRingTicks(center, r, p.bearingStepDeg ?? 30)) out.push(line(t, { role: 'preview-line' }))
      }
    }
    return out
  }
  if (p.kind === 'grid') {
    const rows = Math.max(1, Math.round(p.rows ?? 3))
    const cols = Math.max(1, Math.round(p.cols ?? 3))
    for (const l of gridLines(center, p.sideKm ?? 1, rows, cols)) out.push(line(l, { role: 'preview-line' }))
  }
  return out
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
          <span>　拖顶点手柄改形状；按住图元身上可拖整块移动</span>
          {snapHint && <div style={{ color: '#f59e0b', fontSize: 11 }}>吸附到 {snapHint.label ?? '已有点'}</div>}
          <div style={{ color: '#8fb0cc', fontSize: 11 }}>
            {/* 2026-09-21 需求："支持按键选择，需要提示" —— 按键提示写在这里，与 Esc 同一行 */}
            按 <b style={{ color: '#7fd1ff' }}>R</b> 逆时针旋转 {ROTATE_STEP_DEG}°　·　Esc 退出编辑
          </div>
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
