// map-2d · 视角命令（命令式 API，宿主可主动控制地图）
import { mapInstance, layersReady } from './instance'
import { LayerManager } from '../render/LayerManager'
import { MAP_OPTIONS, zoomToMetersPerPixel, type MapControlKey } from './options'
import { showControls, toggleControl, visibleControls, controlState } from './controls'
import { tileMaxZoomFromOptions, applyTilePrecision } from './tilePrecision'
import { basemaps, type BasemapDef, type BasemapInfo } from './basemaps'
import type { LayerGroup } from '../render/LayerManager'
import { stats as runtimeStats, onPrimitiveError, type PrimitiveError, type RuntimeStats } from './diagnostics'
import { useInteraction, DEFAULT_KIND, type DrawMode, type DrawKind } from './interaction'
import {
  bearingDeg, distanceMeters, pathLengthMeters, polygonAreaM2, insertVertex, removeVertex,
  verticesOf, withVertices, type LngLat,
} from './geometry'
import { MapDraw, type PrimitiveKind } from '../primitives/api'
import {
  exportViewState, restoreViewState, exportImage, downloadImage,
  type ViewState, type RestoreOptions, type ExportImageOptions,
} from './viewState'
import { renderTiming } from './diagnostics'
import {
  loadReplay, clearReplay, play, pause, toggle, setSpeed, seek, seekProgress, step,
  setFollow, status, onReplayChange,
  type ReplayData, type ReplayStatus,
} from './replay'
import type { MapConfigData, MapViewport } from './types'

export const mapCommands = {
  /** 立即设置视角 */
  setView(lng: number, lat: number, zoom?: number, durationMs = 0) {
    const map = mapInstance.current
    if (!map) return
    const z = zoom ?? map.getZoom()
    if (durationMs > 0) map.easeTo({ center: [lng, lat], zoom: z, duration: durationMs })
    else map.jumpTo({ center: [lng, lat], zoom: z })
  },

  /** 平滑飞行 */
  flyTo(lng: number, lat: number, zoom?: number, durationMs = 900) {
    const map = mapInstance.current
    if (!map) return
    map.flyTo({ center: [lng, lat], zoom: zoom ?? map.getZoom(), duration: durationMs })
  },

  /** 聚焦某点（默认街道级） */
  focus(lng: number, lat: number, zoom = 13) {
    LayerManager.focus(lng, lat, zoom)
  },

  /** 复位到配置中的初始视角 */
  resetView(config?: MapConfigData | null) {
    const map = mapInstance.current
    if (!map) return
    const c = config?.center ?? [116.3974, 39.9093]
    const z = config?.zoom ?? 11
    map.easeTo({ center: [c[0], c[1]], zoom: z, bearing: 0, duration: 500 })
  },

  /** 相对缩放 */
  zoomBy(delta: number) {
    mapInstance.current?.easeTo({ zoom: (mapInstance.current?.getZoom() ?? 11) + delta, duration: 220 })
  },

  /** 读取当前视口 */
  getViewport(): MapViewport {
    const map = mapInstance.current
    if (!map) return { lng: 0, lat: 0, zoom: 0, bearing: 0 }
    const c = map.getCenter()
    return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing() }
  },

  /**
   * 地图是否**可画**（图层已建立）。
   *
   * 注意：判据不是"实例是否创建"——`new Map()` 之后实例立即有值，但那时数据源还没建立，
   * 此时写图元会落到不存在的源上。模块内部已对这种情况做了排队（数据保留、就绪后补画），
   * 但宿主最好等本方法返回 true 再灌数据，语义最清晰。
   */
  isReady(): boolean {
    return layersReady.current && !!mapInstance.current
  },

  // ------------------------------------------------------------ 控件按需显示（M2-CTRL-01 ~ 05）
  /** 显示/隐藏指定控件；`on=false` 关闭。未列出的控件保持原状 */
  showControls(keys: MapControlKey | MapControlKey[], on = true) {
    showControls(mapInstance.current, Array.isArray(keys) ? keys : [keys], on)
  },

  /** 切换单个控件的显示状态 */
  toggleControl(key: MapControlKey) {
    toggleControl(mapInstance.current, key)
  },

  /** 当前显示的控件清单 */
  getControls(): MapControlKey[] {
    return visibleControls()
  },

  /** 读取控件开关状态（含未显示的） */
  getControlState(): Record<MapControlKey, boolean> {
    return controlState()
  },

  // ------------------------------------------------------------ 瓦片精度上限（M2-BASE-05）
  /**
   * 限制底图只使用到指定精度（超过上限的层级不再请求，改用较粗瓦片放大显示）。
   * 传 `null` 取消限制；传 `{ maxZoom }` 或 `{ maxMetersPerPixel }` 设定上限。
   * 返回实际生效的最大层级（null 表示不限制）。
   */
  setTilePrecisionLimit(limit: { maxMetersPerPixel?: number; maxZoom?: number } | null): number | null {
    if (limit == null) {
      MAP_OPTIONS.tileMaxMetersPerPixel = null
      applyTilePrecision()
      return null
    }
    MAP_OPTIONS.tileMaxMetersPerPixel =
      limit.maxMetersPerPixel ?? (limit.maxZoom != null ? zoomToMetersPerPixel(limit.maxZoom) : null)
    return MAP_OPTIONS.tileMaxMetersPerPixel == null ? null : applyTilePrecision()
  },

  /** 读取当前精度上限（未设置返回 null） */
  getTilePrecisionLimit(): { maxMetersPerPixel: number; maxZoom: number } | null {
    const mpp = MAP_OPTIONS.tileMaxMetersPerPixel
    if (mpp == null) return null
    return { maxMetersPerPixel: mpp, maxZoom: tileMaxZoomFromOptions() }
  },

  // ------------------------------------------------------------ 底图管理（M2-API-10 ~ 13）
  /** 底图清单（含是否当前） */
  listBasemaps(): BasemapInfo[] {
    return basemaps.list()
  },

  /** 当前底图 */
  currentBasemap(): BasemapDef | null {
    return basemaps.current()
  },

  /** 按标识切换底图（整幅替换）；无效标识返回可读原因，不抛异常 */
  switchBasemap(id: string) {
    return basemaps.switch(id)
  },

  /** 订阅底图切换通知；返回取消订阅函数 */
  onBasemapChange(fn: (def: BasemapDef | null) => void): () => void {
    return basemaps.onChange(fn)
  },

  // ------------------------------------------------------------ 图层顺序与透明度（M2-CTRL-12）
  /** 把某图层分组移动到目标分组之前/之后（调整叠放次序） */
  moveLayerGroup(group: LayerGroup, target: LayerGroup, position: 'before' | 'after' = 'before') {
    return LayerManager.moveGroup(group, target, position)
  },

  /** 当前图层从下到上的顺序（仅模块自己的图层） */
  getLayerOrder(): string[] {
    return LayerManager.layerOrder()
  },

  /** 设置某分组的整体透明度（0–1）；保留图元自身透明度语义 */
  setLayerGroupOpacity(group: LayerGroup, opacity: number) {
    LayerManager.setGroupOpacity(group, opacity)
  },

  /** 读取某分组的透明度（未设置过为 1） */
  getLayerGroupOpacity(group: LayerGroup): number {
    return LayerManager.groupOpacity(group)
  },

  // ------------------------------------------------------------ 回放（M2-DRAW-17 / 18、M2-API-16）
  /** 加载（或替换）回放数据：宿主提供带时间戳的轨迹，模块负责时间轴与渲染 */
  loadReplay(data: ReplayData) {
    return loadReplay(data)
  },

  /** 清空回放数据并停止播放（地图恢复为"无回放"状态） */
  clearReplay() {
    clearReplay()
  },

  /** 播放 / 暂停（播到末尾后再播放会从头开始） */
  playReplay() {
    return play()
  },
  pauseReplay() {
    return pause()
  },
  toggleReplay() {
    return toggle()
  },

  /** 设置倍速（0.25–16，自动夹取） */
  setReplaySpeed(mult: number) {
    return setSpeed(mult)
  },

  /** 定位到指定时刻（毫秒时间戳）或按进度（0–1） */
  seekReplay(t: number) {
    return seek(t)
  },
  seekReplayProgress(p: number) {
    return seekProgress(p)
  },
  /** 步进到相邻采样点（dir: 1 下一个 / -1 上一个） */
  stepReplay(dir: 1 | -1) {
    return step(dir)
  },
  /** 自动跟随开关 */
  setReplayFollow(on: boolean) {
    return setFollow(on)
  },

  /** 读取回放状态（是否加载/播放中/倍速/当前时刻/范围/进度/各对象位置） */
  getReplayStatus(): ReplayStatus {
    return status()
  },

  /** 订阅回放状态变化（播放中每帧回调；宿主可据此联动业务面板） */
  onReplayChange(fn: (s: ReplayStatus) => void) {
    return onReplayChange(fn)
  },

  // ------------------------------------------------------------ 视图状态与导出（M2-API-08 / M2-API-09）
  /** 导出当前视图状态（视角/显示模式/图层开关/透明度/控件/底图/精度上限，默认含图元） */
  async exportViewState(opts: { withPrimitives?: boolean } = {}) {
    return exportViewState(opts)
  },

  /** 恢复视图状态（传入 exportViewState 的结果或其中一个子集） */
  async restoreViewState(state: Partial<ViewState>, opts: RestoreOptions = {}) {
    return restoreViewState(state, opts)
  },

  /** 导出当前地图为图片（dataURL） */
  async exportImage(opts: ExportImageOptions = {}) {
    return exportImage(opts)
  },

  /** 导出并触发下载 */
  async downloadImage(filename?: string, opts: ExportImageOptions = {}) {
    const url = await exportImage(opts)
    downloadImage(url, filename)
    return url
  },

  /** 渲染时机计数（M2-NFR-14）：写入次数 / 渲染次数 / 合并次数 */
  getRenderTiming() {
    return renderTiming()
  },

  // ------------------------------------------------------------ 手绘 / 编辑 / 量算
  //  M2-DRAW-08 手绘交互、M2-DRAW-12 图元编辑、M2-DRAW-14 吸附、M2-CTRL-10 量算

  /** 进入绘制模式：'point' 落点 / 'line' 折线 / 'area' 面 / 'measure-line' 测距 / 'measure-area' 测面 / 'none' 退出 */
  setDrawMode(mode: DrawMode) {
    const st = useInteraction.getState()
    st.setMode(mode)
    if (mode !== 'none') st.setKind(DEFAULT_KIND[mode])
    return { mode, kind: useInteraction.getState().kind, points: 0 }
  },

  /** 当前绘制模式 */
  getDrawMode(): DrawMode {
    return useInteraction.getState().mode
  },

  /** 手动结束当前绘制（等价于双击 / Enter） */
  finishDraw() {
    // 交互层监听了 Escape/Enter；这里通过派发键盘事件复用同一逻辑，避免两套结束路径
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  },

  /** 取消当前绘制或编辑（等价于 Esc） */
  cancelInteraction() {
    useInteraction.getState().reset()
  },

  /** 设置绘制结果写入哪一类图元（默认：点→标注、线→航线、面→区域） */
  setDrawKind(kind: DrawKind) {
    useInteraction.getState().setKind(kind)
  },

  /** 进入图元编辑态（拖动其顶点；仅点/线/面/航线/轨迹等有顶点的类型） */
  editPrimitive(kind: PrimitiveKind, id: string) {
    const exists = (MapDraw.list(kind) as { id: string }[]).some((x) => x.id === id)
    if (!exists) return { ok: false, reason: `未找到图元：${kind}:${id}` }
    useInteraction.getState().startEdit(kind, id)
    return { ok: true }
  },

  /** 结束图元编辑 */
  finishEdit() {
    useInteraction.getState().endEdit()
  },

  /** 当前是否处于编辑态 */
  getEditTarget() {
    return useInteraction.getState().edit
  },

  /** 在编辑目标的第 segIndex 段后插入一个顶点（坐标不传则取该段中点） */
  insertVertexAt(segIndex: number) {
    const st = useInteraction.getState()
    const ed = st.edit
    if (!ed) return { ok: false, reason: '未处于编辑态' }
    const item = (MapDraw.list(ed.kind) as unknown as Record<string, unknown>[]).find((x) => x.id === ed.id)
    if (!item) return { ok: false, reason: '编辑目标已不存在' }
    const vs = verticesOf(ed.kind, item)
    if (segIndex < 0 || segIndex >= vs.length - 1) return { ok: false, reason: '段索引超出范围' }
    const mid: LngLat = [(vs[segIndex][0] + vs[segIndex + 1][0]) / 2, (vs[segIndex][1] + vs[segIndex + 1][1]) / 2]
    const next = insertVertex(vs, segIndex, mid)
    MapDraw.add(ed.kind, withVertices(ed.kind, item, next) as never)
    return { ok: true, vertices: next.length }
  },

  /** 删除编辑目标的第 index 个顶点 */
  removeVertexAt(index: number) {
    const st = useInteraction.getState()
    const ed = st.edit
    if (!ed) return { ok: false, reason: '未处于编辑态' }
    const item = (MapDraw.list(ed.kind) as unknown as Record<string, unknown>[]).find((x) => x.id === ed.id)
    if (!item) return { ok: false, reason: '编辑目标已不存在' }
    const vs = verticesOf(ed.kind, item)
    const min = ed.kind === 'area' ? 3 : 2
    const next = removeVertex(vs, index, min)
    if (next.length === vs.length) return { ok: false, reason: `至少保留 ${min} 个顶点` }
    MapDraw.add(ed.kind, withVertices(ed.kind, item, next) as never)
    return { ok: true, vertices: next.length }
  },

  /** 是否开启顶点吸附 */
  setSnapEnabled(on: boolean) {
    useInteraction.getState().setSnapEnabled(on)
    return useInteraction.getState().snapEnabled
  },

  /** 读取最近一次量算结果（测距 / 测面），无结果为 null */
  getMeasurement() {
    return useInteraction.getState().measurement
  },

  /** 清除量算结果 */
  clearMeasurement() {
    useInteraction.getState().setMeasurement(null)
  },

  // ------------------------------------------------------------ 几何计算（宿主可直接用）
  /** 两点距离（米） */
  distanceMeters(a: LngLat, b: LngLat) {
    return distanceMeters(a, b)
  },

  /** 折线长度（米） */
  pathLengthMeters(points: LngLat[]) {
    return pathLengthMeters(points)
  },

  /** 球面多边形面积（m²） */
  polygonAreaM2(ring: LngLat[]) {
    return polygonAreaM2(ring)
  },

  /** 方位角（度，正北 0、顺时针） */
  bearingDeg(a: LngLat, b: LngLat) {
    return bearingDeg(a, b)
  },

  // ------------------------------------------------------------ 诊断（M2-CTRL-15 / M2-NFR-10）
  /** 运行指标：帧率、各类图元数量、瓦片缓存量、最近一次提交耗时、JS 堆 */
  getStats(): RuntimeStats {
    return runtimeStats()
  },

  /** 订阅"图元数据非法"上报；返回取消订阅函数 */
  onPrimitiveError(fn: (e: PrimitiveError) => void): () => void {
    return onPrimitiveError(fn)
  },
}
