// map-2d · 性能基准脚本（可复现）
//
// 用途：为 M2-NFR-07 / M2-NFR-11 提供**可复现的量化口径**——回归时跑一遍，
//       各项耗时不应超过《需求文档》§4 记录的基线值。
//
// 口径说明（与 §4 一致，务必用同一口径对比）：
//   ① set 耗时：JS 侧把数据翻译为 GeoJSON 并提交给 MapLibre 的墙钟时间（与渲染无关）
//   ② 像素回读：每帧把画布缩绘到 400×300 并 getImageData 的中位耗时（反映渲染负载；同机可比）
//   ③ 单点更新：一次 add() 的耗时（遥测高频路径）
//
// 用法（在独立宿主里跑）：
//   npm run dev            # 或 dev:host
//   浏览器打开 http://localhost:5180/ ，F12 控制台执行：
//     const { runBenchmark } = await import('/src/../examples/benchmark.ts')   // 见下方"如何加载"
//     await runBenchmark(mapInstance.current, MapDraw)
//   随后把控制台输出的表格与《需求文档》§4 对比。
//
// 如何加载：本文件位于模块 examples/ 下，未参与打包。最省事的做法是把它拷到
// src/standalone/ 下临时 import，或按你项目的路径别名加载；也可以直接整段粘进控制台。
import { mapInstance } from '../src/core/instance'
import { MapDraw } from '../src/primitives/api'

type Map = NonNullable<typeof mapInstance.current>

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface Row {
  scene: string
  points: number
  polys: number
  lines?: number
  labels?: number
  setMs: number
  readbackMs: number
}

const rnd = (n: number, spread = 0.4) =>
  Array.from({ length: n }, () => ({
    lng: 116.4 + (Math.random() - 0.5) * spread,
    lat: 39.9 + (Math.random() - 0.5) * spread,
  }))

const ring = (cx: number, cy: number, r: number, n = 8): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.7] as [number, number]
  })

/** 跑一遍基准，返回逐场景结果 */
export async function runBenchmark(map: Map = mapInstance.current as Map, draw = MapDraw) {
  if (!map) throw new Error('地图尚未就绪：先等 mapCommands.isReady() 为 true')

  const probe = document.createElement('canvas')
  probe.width = 400
  probe.height = 300
  const pctx = probe.getContext('2d', { willReadFrequently: true })!
  const canvas = map.getCanvas()

  const readback = () => {
    const t = performance.now()
    pctx.drawImage(canvas, 0, 0, 400, 300)
    pctx.getImageData(0, 0, 400, 300)
    return performance.now() - t
  }
  const readbackMedian = async () => {
    await wait(300)
    const arr: number[] = []
    for (let i = 0; i < 25; i++) {
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
  const timeAdd = (kind: Parameters<typeof draw.add>[0], item: unknown) => {
    const t = performance.now()
    draw.add(kind, item as never)
    return +(performance.now() - t).toFixed(2)
  }

  const rows: Row[] = []
  draw.clear()
  rows.push({ scene: '空载（仅底图）', points: 0, polys: 0, setMs: 0, readbackMs: await readbackMedian() })

  for (const n of [1000, 5000, 20000, 50000]) {
    const ms = timeSet('drone', rnd(n).map((p, i) => ({ id: 'D' + i, lng: p.lng, lat: p.lat })))
    rows.push({ scene: `${n} 无人机点`, points: n, polys: 0, setMs: ms, readbackMs: await readbackMedian() })
  }

  draw.clear()
  for (const n of [500, 2000, 5000]) {
    const ms = timeSet(
      'area',
      Array.from({ length: n }, (_, i) => {
        const p = rnd(1)[0]
        return { id: 'A' + i, polygon: ring(p.lng, p.lat, 0.004), color: '#3b82f6' }
      }),
    )
    rows.push({ scene: `${n} 区域多边形`, points: 0, polys: n, setMs: ms, readbackMs: await readbackMedian() })
  }

  draw.clear()
  const tp = timeSet('drone', rnd(5000).map((p, i) => ({ id: 'D' + i, lng: p.lng, lat: p.lat })))
  const ta = timeSet('area', Array.from({ length: 500 }, (_, i) => {
    const p = rnd(1)[0]
    return { id: 'A' + i, polygon: ring(p.lng, p.lat, 0.003), color: '#22c55e' }
  }))
  const tl = timeSet('link', Array.from({ length: 500 }, (_, i) => {
    const a = rnd(1)[0]
    const b = rnd(1)[0]
    return { id: 'L' + i, from: [a.lng, a.lat] as [number, number], to: [b.lng, b.lat] as [number, number], state: 'green' }
  }))
  const tm = timeSet('label', Array.from({ length: 500 }, (_, i) => {
    const p = rnd(1)[0]
    return { id: 'M' + i, lng: p.lng, lat: p.lat, text: 'M' + i }
  }))
  rows.push({
    scene: '混合：5000 点 + 500 面 + 500 线 + 500 标注',
    points: 5000, polys: 500, lines: 500, labels: 500,
    setMs: +(tp + ta + tl + tm).toFixed(1),
    readbackMs: await readbackMedian(),
  })

  const updates = [
    timeAdd('drone', { id: 'D0', lng: 116.41, lat: 39.91 }),
    timeAdd('drone', { id: 'D1', lng: 116.42, lat: 39.92 }),
    timeAdd('drone', { id: 'D2', lng: 116.43, lat: 39.93 }),
  ]
  const avgUpdate = +(updates.reduce((a, b) => a + b, 0) / updates.length).toFixed(2)

  const result = {
    viewport: `${canvas.clientWidth}x${canvas.clientHeight}`,
    rows,
    avgSingleUpdateMs: avgUpdate,
    jsHeapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576)
      : null,
    baselineRef: '《需求文档》§4 性能基线（2026-06-11 实测）',
  }
  console.table(result.rows)
  console.log('单点更新平均耗时(ms):', result.avgSingleUpdateMs, '｜ JS 堆(MB):', result.jsHeapMB)
  console.log('对比基线：set 耗时不应超过 §4 记录值；超出即视为劣化（M2-NFR-07）')
  return result
}
