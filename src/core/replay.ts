// map-2d · 时间轴回放（需求 M2-DRAW-17 / M2-DRAW-18 / M2-API-16）
//
// 分工（决策 D6，写死在设计里）：
//   · **宿主负责**：带时间戳的轨迹数据与其存储、持久化、下发时机
//   · **模块负责**：时间轴、播放控制（播放/暂停/倍速/拖拽定位/自动跟随）、按当前时刻截取并渲染
//
// 数据模型：一条"回放轨迹"= 一个对象（无人机/目标）在一段时间内的采样点序列。
// 采样点之间的位置用**线性插值**（经纬度线性；轨迹点通常秒级密集，足够平滑），
// 这样宿主只需给离散点，不必关心帧率。
import { create } from 'zustand'
import { MapDraw, type PrimitiveKind } from '../primitives/api'
import { mapInstance } from './instance'
import { distanceMeters, type LngLat } from './geometry'

/** 一个轨迹采样点 */
export interface ReplaySample {
  /** 时间戳（毫秒，Unix epoch） */
  t: number
  lng: number
  lat: number
  /** 航向（度，正北 0）；不给则由相邻点推算 */
  heading?: number
  /** 速度（米/秒）；不给则由相邻点推算 */
  speed?: number
  /** 该点的附加属性（原样透传给渲染与回调） */
  props?: Record<string, unknown>
}

/** 一条回放轨迹（一个对象的时序位置） */
export interface ReplayTrack {
  /** 对象标识（渲染时用作图元 id） */
  id: string
  /** 显示名（可选） */
  label?: string
  /** 渲染成哪一类图元（默认 drone；目标轨迹可用 target） */
  kind?: Extract<PrimitiveKind, 'drone' | 'target' | 'label'>
  color?: string
  /** 按时间升序的采样点 */
  samples: ReplaySample[]
}

export interface ReplayData {
  /** 数据标识（便于宿主区分多份数据） */
  id?: string
  tracks: ReplayTrack[]
}

/** 某个对象在当前时刻的状态 */
export interface ReplayState {
  id: string
  label?: string
  lng: number
  lat: number
  heading: number | null
  speed: number | null
  /** 当前所处的采样区间下标（前一个点） */
  index: number
  props?: Record<string, unknown>
  color?: string
  /** 该时刻是否有该对象的数据（超出其时间范围的为 false） */
  active: boolean
}

export interface ReplayStatus {
  /** 是否已加载数据 */
  loaded: boolean
  playing: boolean
  /** 倍速 */
  speed: number
  /** 当前时刻（毫秒） */
  current: number
  /** 数据时间范围 */
  start: number
  end: number
  /** 进度 0–1 */
  progress: number
  /** 总时长（毫秒） */
  duration: number
  /** 自动跟随 */
  follow: boolean
  /** 当前各对象状态 */
  states: ReplayState[]
  /** 数据标识 */
  dataId?: string
}

type Listener = (s: ReplayStatus) => void

/** 时间轴状态的内部存储（用 zustand 是为了让 React 组件订阅） */
interface ReplayStore extends ReplayStatus {
  set: (patch: Partial<ReplayStatus>) => void
}

export const useReplay = create<ReplayStore>((set) => ({
  loaded: false,
  playing: false,
  speed: 1,
  current: 0,
  start: 0,
  end: 0,
  progress: 0,
  duration: 0,
  follow: true,
  states: [],
  dataId: undefined,
  set: (patch) => set(patch),
}))

// ---------------------------------------------------------------- 内部状态（非 React 订阅部分）

let data: ReplayData | null = null
let rafId = 0
let lastTick = 0
const listeners = new Set<Listener>()
/** 上一次写入地图的状态签名，避免每帧都写（只有位置/时刻变化才写） */
let lastSignature = ''

/** 订阅回放状态变化（宿主可据此联动业务面板） */
export function onReplayChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  const s = useReplay.getState()
  const snapshot: ReplayStatus = {
    loaded: s.loaded, playing: s.playing, speed: s.speed, current: s.current,
    start: s.start, end: s.end, progress: s.progress, duration: s.duration,
    follow: s.follow, states: s.states, dataId: s.dataId,
  }
  applyFollow(snapshot)
  for (const fn of [...listeners]) {
    try { fn(snapshot) } catch { /* 单个回调异常不影响其它 */ }
  }
}

/**
 * 自动跟随（M2-DRAW-17 的"自动跟随"项）：
 * 把视角中心跟到"第一个活跃对象"上。用 jumpTo 而不是 easeTo——
 * 回放是逐帧连续的，easeTo 每帧都会打断上一段动画，反而抖动。
 */
let lastFollowKey = ''
function applyFollow(s: ReplayStatus) {
  if (!s.follow || !s.playing) return
  const map = mapInstance.current
  if (!map) return
  const target = s.states.find((x) => x.active)
  if (!target) return
  // 位置没变就不动相机（省掉无谓重绘）
  const key = target.id + ':' + target.lng.toFixed(5) + ',' + target.lat.toFixed(5)
  if (key === lastFollowKey) return
  lastFollowKey = key
  map.jumpTo({ center: [target.lng, target.lat] })
}

// ---------------------------------------------------------------- 插值

/** 找到 t 时刻在 samples 中的区间下标（二分；返回最后一个 <= t 的下标） */
function lowerIndex(samples: ReplaySample[], t: number): number {
  let lo = 0
  let hi = samples.length - 1
  if (t <= samples[0].t) return 0
  if (t >= samples[hi].t) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 计算某条轨迹在 t 时刻的状态（线性插值；t 超出范围时取端点并标 active=false） */
export function sampleAt(track: ReplayTrack, t: number): ReplayState | null {
  const s = track.samples
  if (!s.length) return null
  const i = lowerIndex(s, t)
  const a = s[i]
  const b = s[Math.min(i + 1, s.length - 1)]
  const inRange = t >= s[0].t && t <= s[s.length - 1].t

  let lng = a.lng
  let lat = a.lat
  let heading = a.heading ?? null
  let speed = a.speed ?? null

  if (b !== a) {
    const span = b.t - a.t
    const k = span > 0 ? Math.max(0, Math.min(1, (t - a.t) / span)) : 0
    lng = a.lng + (b.lng - a.lng) * k
    lat = a.lat + (b.lat - a.lat) * k
    if (a.heading == null || b.heading == null) {
      // 未给航向 → 由相邻点推算
      const dLng = b.lng - a.lng
      const dLat = b.lat - a.lat
      heading = (Math.atan2(dLng, dLat) * 180) / Math.PI
    }
    if (a.speed == null && span > 0) {
      speed = distanceMeters([a.lng, a.lat], [b.lng, b.lat]) / (span / 1000)
    }
  }

  return {
    id: track.id,
    label: track.label,
    lng, lat,
    heading: heading == null ? null : (heading + 360) % 360,
    speed,
    index: i,
    props: a.props,
    color: track.color,
    // 超出该对象时间范围时为 false：渲染层据此不显示（例如目标 15 秒后才出现）
    active: inRange,
  }
}

/** 计算全部轨迹在 t 时刻的状态 */
export function sampleAll(t: number): ReplayState[] {
  if (!data) return []
  return data.tracks.map((tr) => sampleAt(tr, t)).filter((x): x is ReplayState => !!x)
}

// ---------------------------------------------------------------- 渲染到地图

/**
 * 把当前时刻的状态写入图元集合。
 * 只写"该时刻在数据范围内的"对象——范围外的对象不显示（避免把 10 分钟前的点一直挂在图上）。
 */
function renderAt(t: number) {
  const states = sampleAll(t).filter((s) => s.active)
  const signature = states.map((s) => `${s.id}:${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join('|')
  if (signature === lastSignature) return states
  lastSignature = signature

  const byKind: Record<string, ReplayState[]> = { drone: [], target: [], label: [] }
  for (const s of states) {
    if (!data) continue
    const tr = data.tracks.find((x) => x.id === s.id)
    const kind = tr?.kind ?? 'drone'
    byKind[kind].push(s)
  }

  // 无人机/目标：整组替换为"当前时刻的活跃对象"
  MapDraw.set('drone', byKind.drone.map((s) => ({
    id: s.id, lng: s.lng, lat: s.lat, label: s.label ?? s.id, color: s.color,
  })) as never)
  MapDraw.set('target', byKind.target.map((s) => ({
    id: s.id, lng: s.lng, lat: s.lat, label: s.label ?? s.id, color: s.color,
  })) as never)

  // 尾迹：把"已经走过的部分"画成轨迹线（模块自带的时间轴可视化）
  if (data) {
    const trails = data.tracks
      .filter((tr) => (tr.kind ?? 'drone') === 'drone')
      .map((tr) => {
        const passed = tr.samples.filter((x) => x.t <= t)
        const st = states.find((s) => s.id === tr.id)
        const pts: LngLat[] = passed.map((x) => [x.lng, x.lat])
        if (st && st.active) pts.push([st.lng, st.lat])
        return pts.length >= 2 ? { id: `trail-${tr.id}`, points: pts, color: tr.color ?? '#22d3ee', dashed: false } : null
      })
      .filter(Boolean)
    MapDraw.set('route', trails as never)
  }

  return states
}

// ---------------------------------------------------------------- 播放循环

function tick(now: number) {
  const st = useReplay.getState()
  if (!st.playing) return
  const dt = now - lastTick
  lastTick = now
  let next = st.current + dt * st.speed
  if (next >= st.end) {
    next = st.end
    st.set({ current: next, playing: false, progress: 1, states: renderAt(next) })
    emit()
    return
  }
  st.set({ current: next, progress: st.duration ? (next - st.start) / st.duration : 0, states: renderAt(next) })
  emit()
  rafId = requestAnimationFrame(tick)
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

// ---------------------------------------------------------------- 对外 API

/** 加载（或替换）回放数据 */
export function loadReplay(d: ReplayData): ReplayStatus {
  const tracks = (d.tracks ?? [])
    .map((tr) => ({ ...tr, samples: [...tr.samples].sort((a, b) => a.t - b.t) }))
    .filter((tr) => tr.samples.length > 0)

  data = { id: d.id, tracks }
  const all = tracks.flatMap((tr) => tr.samples.map((s) => s.t))
  const start = all.length ? Math.min(...all) : 0
  const end = all.length ? Math.max(...all) : 0
  lastSignature = ''

  useReplay.getState().set({
    loaded: tracks.length > 0, playing: false, current: start, start, end,
    duration: end - start, progress: 0, states: renderAt(start), dataId: d.id,
  })
  emit()
  return status()
}

/** 清空回放数据并停止播放（地图恢复到"无回放"状态） */
export function clearReplay() {
  stopLoop()
  data = null
  lastSignature = ''
  MapDraw.set('drone', [] as never)
  MapDraw.set('target', [] as never)
  MapDraw.set('route', [] as never)
  useReplay.getState().set({
    loaded: false, playing: false, current: 0, start: 0, end: 0, duration: 0,
    progress: 0, states: [], dataId: undefined,
  })
  emit()
}

/** 播放 */
export function play() {
  const st = useReplay.getState()
  if (!st.loaded || st.playing) return status()
  // 播到末尾后再点播放 → 从头开始
  const from = st.current >= st.end ? st.start : st.current
  st.set({ playing: true, current: from, states: renderAt(from) })
  lastTick = performance.now()
  stopLoop()
  rafId = requestAnimationFrame(tick)
  emit()
  return status()
}

/** 暂停 */
export function pause() {
  stopLoop()
  useReplay.getState().set({ playing: false })
  emit()
  return status()
}

/** 播放/暂停切换 */
export function toggle() {
  return useReplay.getState().playing ? pause() : play()
}

/** 设置倍速（0.25 – 16） */
export function setSpeed(mult: number) {
  const s = Math.max(0.25, Math.min(16, mult))
  useReplay.getState().set({ speed: s })
  emit()
  return status()
}

/** 定位到某时刻（拖拽时间轴用；播放中定位不会打断播放） */
export function seek(t: number) {
  const st = useReplay.getState()
  if (!st.loaded) return status()
  const clamped = Math.max(st.start, Math.min(st.end, t))
  st.set({ current: clamped, progress: st.duration ? (clamped - st.start) / st.duration : 0, states: renderAt(clamped) })
  if (clamped >= st.end && st.playing) { stopLoop(); st.set({ playing: false }) }
  emit()
  return status()
}

/** 按进度定位（0–1，时间轴滑块的直觉用法） */
export function seekProgress(p: number) {
  const st = useReplay.getState()
  return seek(st.start + Math.max(0, Math.min(1, p)) * st.duration)
}

/** 步进到相邻采样点（便于"逐帧"查看） */
export function step(dir: 1 | -1) {
  const st = useReplay.getState()
  if (!data || !st.loaded) return status()
  const idx = Math.max(0, st.states[0]?.index ?? 0)
  const next = data.tracks[0]?.samples[idx + dir]
  if (next) seek(next.t)
  return status()
}

/** 自动跟随：播放时把视角跟到对象上（默认开启） */
export function setFollow(on: boolean) {
  useReplay.getState().set({ follow: on })
  emit()
  return status()
}

/** 读取当前回放状态 */
export function status(): ReplayStatus {
  const st = useReplay.getState()
  return {
    loaded: st.loaded, playing: st.playing, speed: st.speed, current: st.current,
    start: st.start, end: st.end, progress: st.progress, duration: st.duration,
    follow: st.follow, states: st.states, dataId: st.dataId,
  }
}

/** 读取原始回放数据（只读；宿主若需修改请重新 load） */
export function replayData(): ReplayData | null {
  return data
}

/** 全部采样点的时间范围 */
export function replayRange(): { start: number; end: number } {
  const st = useReplay.getState()
  return { start: st.start, end: st.end }
}
