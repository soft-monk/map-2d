// map-2d · 全球低精度瓦片预热（"地板层"）
//
// 背景：MapLibre 只加载**当前视口**内的瓦片，视口之外的瓦片是"可加载"而不是"已加载"。
// 所以低缩放拖拽时会短暂露出缺口底色（观感上就是"未加载的方块"）。
// 本文件把"全球低精度层一次性装进来"这件事做成一个可复用、可上报进度的纯函数，
// 由宿主在启动阶段调用（此时地图往往还没创建，所以它不依赖 MapLibre 实例）。
//
// ⚠️ 三个必须遵守的点（改这里之前请先读）：
//   1. 只能用 fetch()：`new Image()` 的预载只进"图片缓存"，MapLibre 之后走 fetch 请求同一
//      URL 时命中不了，等于白预热。
//   2. 预热 ≠ 已解码：这里只把字节放进 HTTP 缓存；真正画到屏上时仍需解码 + 上传纹理（毫秒级）。
//      效果是"拖过去立刻有内容"，而不是"零开销"。
//   3. 视口内的高清层不受影响：本函数只碰低层级瓦片，不动任何图层可见性与业务数据。

/** 预热进度快照 */
export interface PreloadProgress {
  /** 计划预热的瓦片总数 */
  total: number
  /** 已处理（成功 + 失败）数量 */
  done: number
  ok: number
  failed: number
  /** 累计字节数（按 Content-Length 累加，缺失时按 0 计） */
  bytes: number
  /** 0–1 */
  ratio: number
}

/** 预热结果 */
export interface PreloadResult extends PreloadProgress {
  /** 是否被 signal 取消 */
  aborted: boolean
  /** 总耗时（毫秒） */
  ms: number
  /** 实际使用的并发数 */
  concurrency: number
  /** 失败瓦片的 URL（最多保留 20 条，便于排查） */
  failedUrls: string[]
}

export interface PreloadOptions {
  /** 瓦片 URL 模板，如 `/tiles/raster/{z}/{x}/{y}.jpg` */
  template: string
  /** 预热到的最大层级（含）；建议 0–6，默认取 MAP_OPTIONS.preloadMaxZoom */
  maxZoom: number
  /** 并发数；默认 8（实测局域网下 8 并发已接近服务端吞吐上限） */
  concurrency?: number
  /** 进度回调（每个瓦片结束时触发一次） */
  onProgress?: (p: PreloadProgress) => void
  /** 取消信号 */
  signal?: AbortSignal
  /** 单个瓦片失败后的重试次数，默认 1 */
  retries?: number
  /** 单个瓦片超时（毫秒），默认 10000；避免慢盘/掉线把启动卡死 */
  timeoutMs?: number
}

/** 把模板里的 {z}/{x}/{y} 换成具体坐标 */
export function tileUrlAt(template: string, z: number, x: number, y: number): string {
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
}

/** 生成 z0..maxZoom 的全球瓦片坐标（含层级顺序：从粗到细，先保证"整个地球都有"） */
export function worldTileList(maxZoom: number): { z: number; x: number; y: number }[] {
  const out: { z: number; x: number; y: number }[] = []
  for (let z = 0; z <= maxZoom; z++) {
    const n = 2 ** z
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) out.push({ z, x, y })
    }
  }
  return out
}

/** 某一层级的瓦片数量（2^z 的平方） */
export function tilesAtZoom(z: number): number {
  return 2 ** (2 * z)
}

/** 预热的瓦片总数与粗略体积估算（用于界面提示 / 决策；体积按实测均值 8 KB/张） */
export function preloadEstimate(maxZoom: number, avgBytes = 8 * 1024) {
  const total = worldTileList(maxZoom).length
  return { total, bytes: total * avgBytes }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function fetchOne(url: string, timeoutMs: number, signal?: AbortSignal): Promise<number> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // cache: 'default' —— 允许浏览器缓存命中；预热本身就是"把字节放进缓存"
    const res = await fetch(url, { cache: 'default', signal: ctrl.signal })
    if (!res.ok) throw new Error(String(res.status))
    const buf = await res.arrayBuffer()
    return buf.byteLength
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 预热全球低精度瓦片（默认 z0–4，共 341 张 / 约 2.7 MB，局域网实测 ≈ 0.2–0.3 s）。
 *
 * 单个瓦片失败不会中断整体：重试 `retries` 次后计入 `failed` 并继续。
 * 外部取消（`signal`）会尽快停止，适合"用户点跳过"的场景。
 */
export async function preloadWorldTiles(opts: PreloadOptions): Promise<PreloadResult> {
  const { template, maxZoom, onProgress, signal } = opts
  const concurrency = Math.max(1, Math.min(32, opts.concurrency ?? 8))
  const retries = Math.max(0, opts.retries ?? 1)
  const timeoutMs = Math.max(500, opts.timeoutMs ?? 10_000)

  const list = worldTileList(maxZoom)
  const progress: PreloadProgress = { total: list.length, done: 0, ok: 0, failed: 0, bytes: 0, ratio: 0 }
  const failedUrls: string[] = []
  const t0 = Date.now()
  let cursor = 0

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = cursor++
      if (i >= list.length) return
      const { z, x, y } = list[i]
      const url = tileUrlAt(template, z, x, y)
      let bytes = 0
      let ok = false
      for (let attempt = 0; attempt <= retries && !signal?.aborted; attempt++) {
        try {
          bytes = await fetchOne(url, timeoutMs, signal)
          ok = true
          break
        } catch {
          if (signal?.aborted) break
          if (attempt < retries) await sleep(120)
        }
      }
      if (ok) {
        progress.ok++
        progress.bytes += bytes
      } else if (!signal?.aborted) {
        progress.failed++
        if (failedUrls.length < 20) failedUrls.push(url)
      }
      progress.done++
      progress.ratio = progress.total ? progress.done / progress.total : 1
      onProgress?.({ ...progress })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))

  return { ...progress, aborted: !!signal?.aborted, ms: Date.now() - t0, concurrency, failedUrls }
}
