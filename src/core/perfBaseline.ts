// map-2d · 性能基线与预算（需求 M2-NFR-07 图元容量基线 / M2-NFR-11 性能预算）
//
// 两件事：
//   ① **基线**：把实测数字固化成常量（来源：需求文档 §4，本机无头 Chrome 口径），
//      并给出可回归的对比函数——超基线即视为劣化。
//   ② **预算**：把"关键路径的可测量指标"定义清楚（首屏可交互、连续帧率、批量提交、
//      单点更新、堆占用），并允许宿主覆盖为自己的机器口径。
//
// 为什么基线是**数据**而不是断言：性能随机器差异极大。模块给出本机基准值 + 对比逻辑，
// 宿主在自己的机器上跑一次 `runBenchmark()` 得到自己的基线，之后回归就有意义了。
import type { Map as MlMap } from 'maplibre-gl'
import { MapDraw } from '../primitives/api'
import { mapInstance } from './instance'
import { stats } from './diagnostics'

/** 一条基线记录 */
export interface BaselineEntry {
  /** 场景名 */
  scene: string
  /** 本机实测值（毫秒；提交耗时） */
  setMs: number
  /** 每帧像素回读中位耗时（毫秒） */
  readbackMs: number
  /** 允许的劣化容差（倍数，默认 1.5 = 允许慢 50%） */
  tolerance?: number
}

/**
 * 需求文档 §4 记录的基线（2026-06-11，本机无头 Chrome / SwiftShader / 画布 1582×748）。
 * ⚠️ 换机器请重跑 `runBenchmark()` 并更新这里，或调用 `setBaseline()` 覆盖。
 */
export const BASELINE: BaselineEntry[] = [
  { scene: '空载（仅底图）', setMs: 0, readbackMs: 3.1 },
  { scene: '1,000 无人机点', setMs: 1.2, readbackMs: 2.6 },
  { scene: '5,000 无人机点', setMs: 3.3, readbackMs: 2.8 },
  { scene: '20,000 无人机点', setMs: 15.2, readbackMs: 3.1 },
  { scene: '50,000 无人机点', setMs: 32.4, readbackMs: 3.7 },
  { scene: '500 区域多边形', setMs: 1.4, readbackMs: 3.2 },
  { scene: '2,000 区域多边形', setMs: 3.7, readbackMs: 2.6 },
  { scene: '5,000 区域多边形', setMs: 8.7, readbackMs: 2.3 },
  // 混合场景 5.1 → 11 的说明：该场景含 500 个标注，会走**标签分级过滤**（M2-DRAW-11）
  // 与**渲染降级检查**（M2-NFR-13）两条新增路径——这是功能增加带来的成本，不是退化
  // （绝对耗时 11ms 仍在一帧预算 20ms 内）。基线随后续功能按此更新。
  { scene: '混合：5,000 点 + 500 面 + 500 线 + 500 标注', setMs: 11, readbackMs: 2.2 },
  { scene: '单点更新（遥测路径，300 点时）', setMs: 1.7, readbackMs: 0 },
]

/**
 * 性能预算：关键路径的可测量门槛（需求 M2-NFR-11）。
 * 与基线不同，预算回答的是"**够不够用**"，因此用绝对阈值而不是相对倍数。
 */
export interface PerfBudget {
  /** 首屏可交互时间（从建图到 isReady 为 true，毫秒） */
  firstInteractiveMs: number
  /** 连续交互时的最低帧率 */
  minFps: number
  /** 20,000 点位或 5,000 多边形单次提交上限（毫秒，一帧内完成 = 16.7ms，留余量取 20） */
  batchSubmitMs: number
  /** 单点更新上限（毫秒，遥测路径） */
  singleUpdateMs: number
  /** JS 堆占用上限（MB，混合负载后） */
  heapMB: number
}

export const DEFAULT_BUDGET: PerfBudget = {
  firstInteractiveMs: 3000,
  minFps: 30,
  batchSubmitMs: 20,
  singleUpdateMs: 2,
  heapMB: 200,
}

let budget: PerfBudget = { ...DEFAULT_BUDGET }
let baseline: BaselineEntry[] = BASELINE.map((b) => ({ ...b }))

export function setPerfBudget(patch: Partial<PerfBudget>): PerfBudget {
  budget = { ...budget, ...patch }
  return { ...budget }
}

export function getPerfBudget(): PerfBudget {
  return { ...budget }
}

/** 覆盖基线（换机器后重跑基准，把结果写回） */
export function setBaseline(entries: BaselineEntry[]): BaselineEntry[] {
  baseline = entries.map((b) => ({ ...b }))
  return baseline.map((b) => ({ ...b }))
}

/**
 * 用刚跑出来的结果**刷新基线**（换机器或功能演进后使用）。
 * 只更新"两边都有的场景"，不会凭空添加条目。
 */
export function adoptBaselineFrom(rows: BenchRow[]): BaselineEntry[] {
  baseline = baseline.map((b) => {
    const cur = rows.find((r) => r.scene === b.scene)
    return cur && cur.setMs > 0 ? { ...b, setMs: cur.setMs, readbackMs: cur.readbackMs || b.readbackMs } : b
  })
  return baseline.map((b) => ({ ...b }))
}

export function getBaseline(): BaselineEntry[] {
  return baseline.map((b) => ({ ...b }))
}

// ---------------------------------------------------------------- 基准运行

export interface BenchRow {
  scene: string
  setMs: number
  readbackMs: number
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const rnd = (n: number, spread = 0.4) =>
  Array.from({ length: n }, () => ({
    lng: 116.3 + (Math.random() - 0.5) * spread,
    lat: 39.9 + (Math.random() - 0.5) * spread * 0.7,
  }))
const ring = (cx: number, cy: number, r: number, n = 8): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number]
  })

/** 跑一遍基准，返回同口径表格（与需求文档 §4 一致） */
export async function runBenchmark(map: MlMap | null = mapInstance.current, draw = MapDraw): Promise<BenchRow[]> {
  if (!map) throw new Error('地图尚未就绪：先等 mapCommands.isReady() 为 true')
  const probe = document.createElement('canvas')
  probe.width = 400
  probe.height = 300
  const pctx = probe.getContext('2d', { willReadFrequently: true })
  const canvas = map.getCanvas()

  const readback = () => {
    const t = performance.now()
    pctx?.drawImage(canvas, 0, 0, 400, 300)
    pctx?.getImageData(0, 0, 400, 300)
    return performance.now() - t
  }
  const readbackMedian = async () => {
    await wait(260)
    const arr: number[] = []
    for (let i = 0; i < 21; i++) {
      arr.push(readback())
      await wait(16)
    }
    arr.sort((a, b) => a - b)
    return +arr[Math.floor(arr.length / 2)].toFixed(2)
  }
  const timeSet = (kind: Parameters<typeof draw.set>[0], items: unknown[]) => {
    const t = performance.now()
    draw.set(kind, items as never)
    return +(performance.now() - t).toFixed(1)
  }

  const rows: BenchRow[] = []
  draw.clear()
  rows.push({ scene: '空载（仅底图）', setMs: 0, readbackMs: await readbackMedian() })

  for (const n of [1000, 5000, 20000, 50000]) {
    const ms = timeSet('drone', rnd(n).map((p, i) => ({ id: 'D' + i, lng: p.lng, lat: p.lat })))
    rows.push({ scene: `${n.toLocaleString()} 无人机点`, setMs: ms, readbackMs: await readbackMedian() })
  }

  draw.clear()
  for (const n of [500, 2000, 5000]) {
    const ms = timeSet('area', Array.from({ length: n }, (_, i) => {
      const c = rnd(1)[0]
      return { id: 'A' + i, polygon: ring(c.lng, c.lat, 0.004) }
    }))
    rows.push({ scene: `${n.toLocaleString()} 区域多边形`, setMs: ms, readbackMs: await readbackMedian() })
  }

  // 混合负载
  draw.clear()
  const t0 = performance.now()
  draw.batch(() => {
    draw.set('drone', rnd(5000).map((p, i) => ({ id: 'M' + i, lng: p.lng, lat: p.lat })))
    draw.set('area', Array.from({ length: 500 }, (_, i) => { const c = rnd(1)[0]; return { id: 'MA' + i, polygon: ring(c.lng, c.lat, 0.004) } }))
    draw.set('route', Array.from({ length: 500 }, (_, i) => { const c = rnd(1)[0]; return { id: 'MR' + i, points: [ring(c.lng, c.lat, 0.003, 4)[0], ring(c.lng, c.lat, 0.003, 4)[2]] } }))
    draw.set('label', Array.from({ length: 500 }, (_, i) => { const c = rnd(1)[0]; return { id: 'ML' + i, lng: c.lng, lat: c.lat, text: 'L' + i, radius: 0 } }))
  })
  const mixedMs = +(performance.now() - t0).toFixed(1)
  rows.push({ scene: '混合：5,000 点 + 500 面 + 500 线 + 500 标注', setMs: mixedMs, readbackMs: await readbackMedian() })

  // 单点更新（遥测路径）
  draw.set('drone', rnd(300).map((p, i) => ({ id: 'T' + i, lng: p.lng, lat: p.lat })))
  await wait(120)
  const updates: number[] = []
  for (let k = 0; k < 30; k++) {
    const p = rnd(1)[0]
    const t = performance.now()
    draw.add('drone', { id: 'T' + (k % 300), lng: p.lng, lat: p.lat })
    updates.push(performance.now() - t)
  }
  updates.sort((a, b) => a - b)
  rows.push({ scene: '单点更新（遥测路径，300 点时）', setMs: +(updates[Math.floor(updates.length / 2)]).toFixed(2), readbackMs: 0 })

  return rows
}

// ---------------------------------------------------------------- 回归对比

export interface RegressionResult {
  /** 是否全部通过（未劣化） */
  ok: boolean
  rows: {
    scene: string
    baselineMs: number
    currentMs: number
    /** 当前 / 基线 */
    ratio: number
    tolerance: number
    ok: boolean
    note?: string
  }[]
  /** 预算检查结果 */
  budget: { name: string; limit: string; actual: string; ok: boolean }[]
  summary: string
}

/**
 * 与基线对比：超容差即判为劣化。
 * 预算检查同时进行：帧率、堆占用（批量提交与单点更新由基准行覆盖）。
 */
export async function checkRegression(opts: { map?: MlMap | null; draw?: typeof MapDraw } = {}): Promise<RegressionResult> {
  const rows = await runBenchmark(opts.map ?? mapInstance.current, opts.draw ?? MapDraw)
  const out: RegressionResult['rows'] = []
  for (const b of baseline) {
    const cur = rows.find((r) => r.scene === b.scene)
    if (!cur || !b.setMs) continue
    const tol = b.tolerance ?? 1.5
    const ratio = +(cur.setMs / b.setMs).toFixed(2)
    out.push({ scene: b.scene, baselineMs: b.setMs, currentMs: cur.setMs, ratio, tolerance: tol, ok: ratio <= tol })
  }

  const s = stats()
  const budgetRows = [
    { name: '连续帧率', limit: `≥ ${budget.minFps} fps`, actual: `${s.fps} fps`, ok: s.fps >= budget.minFps },
    { name: 'JS 堆占用', limit: `≤ ${budget.heapMB} MB`, actual: s.jsHeapMB == null ? '（不可测）' : `${s.jsHeapMB} MB`, ok: s.jsHeapMB == null || s.jsHeapMB <= budget.heapMB },
    {
      name: '批量提交（20k 点）',
      limit: `≤ ${budget.batchSubmitMs} ms`,
      actual: (() => { const r = rows.find((x) => x.scene.startsWith('20,000')); return r ? `${r.setMs} ms` : '（未测）' })(),
      ok: (() => { const r = rows.find((x) => x.scene.startsWith('20,000')); return !r || r.setMs <= budget.batchSubmitMs })(),
    },
    {
      name: '单点更新',
      limit: `≤ ${budget.singleUpdateMs} ms`,
      actual: (() => { const r = rows.find((x) => x.scene.startsWith('单点更新')); return r ? `${r.setMs} ms` : '（未测）' })(),
      ok: (() => { const r = rows.find((x) => x.scene.startsWith('单点更新')); return !r || r.setMs <= budget.singleUpdateMs })(),
    },
  ]

  const bad = out.filter((r) => !r.ok)
  const badBudget = budgetRows.filter((r) => !r.ok)
  const ok = bad.length === 0 && badBudget.length === 0
  return {
    ok,
    rows: out,
    budget: budgetRows,
    summary: ok
      ? `全部通过：${out.length} 项基线与 ${budgetRows.length} 项预算均未劣化`
      : `发现 ${bad.length} 项基线劣化、${badBudget.length} 项预算超限：${[...bad.map((b) => b.scene), ...badBudget.map((b) => b.name)].join('、')}`,
  }
}
