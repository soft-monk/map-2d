// map-2d · 瓦片请求的网络层计数（需求 M2-MAP-10 的判定依据）
//
// 为什么需要它：MapLibre 的 `sourcedata`（含带 tile 字段的）是**逐瓦片进度事件**，
// 真实页面每秒触发上千次（实测 5 秒 9199 次），用它统计"成功加载数"会把数字抬得极高，
// 使"错误多且几乎无成功"的降级条件永远不成立（第八轮实测发现）。
//
// 因此改为**网络层挂钩**：包一层 fetch / XMLHttpRequest，只统计**看起来是瓦片请求的 URL**
// （命中瓦片模板特征），其余请求原样透传、不计入、不改变行为。
// 这样得到的是"真实 HTTP 成败"，与渲染器的内部事件无关。

export interface TileNetStats {
  /** 窗口内成功数 / 失败数 */
  ok: number
  fail: number
  /** 最近一次失败的原因（可读） */
  lastError: string
  /** 失败的 URL 样例（最多 5 条） */
  samples: string[]
}

const WINDOW_MS = 6000
let oks: number[] = []
let fails: number[] = []
let samples: string[] = []
let lastError = ''
let installed = false

/** 瓦片 URL 特征：模板占位符展开后通常是 /z/x/y.ext，这里用目录+数字后缀判断 */
const TILE_PATTERN = /\/\d+\/\d+\/\d+\.(?:jpg|jpeg|png|webp|pbf|mvt|terrain)(?:\?|$)/i

export function looksLikeTile(url: string): boolean {
  return TILE_PATTERN.test(url)
}

function prune(now: number) {
  oks = oks.filter((t) => now - t <= WINDOW_MS)
  fails = fails.filter((t) => now - t <= WINDOW_MS)
  if (!fails.length) { samples = []; lastError = '' }
}

export function tileNetStats(): TileNetStats {
  prune(performance.now())
  return { ok: oks.length, fail: fails.length, lastError, samples: [...samples] }
}

/** 由 tileFallback 主动上报一次结果（也供测试注入） */
export function reportTileRequest(url: string, ok: boolean, error?: string) {
  const now = performance.now()
  if (ok) oks.push(now)
  else {
    fails.push(now)
    lastError = error ?? 'unknown'
    if (url && !samples.includes(url) && samples.length < 5) samples.push(url)
  }
  prune(now)
}

/** 重置（测试/排障用） */
export function resetTileNetStats() {
  oks = []
  fails = []
  samples = []
  lastError = ''
}

/**
 * 安装网络层挂钩（幂等）。只包一次，且只对**瓦片请求**计数。
 * 注意：不改动返回内容与错误传播——失败的请求依旧以原样抛给调用方（MapLibre 自己会处理）。
 */
export function installTileNetworkHook() {
  if (installed || typeof window === 'undefined') return
  installed = true

  const origFetch = window.fetch?.bind(window)
  if (origFetch) {
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const isTile = looksLikeTile(url)
      try {
        const res = await origFetch(input as never, init)
        if (isTile) reportTileRequest(url, res.ok, res.ok ? undefined : `HTTP ${res.status}`)
        return res
      } catch (e) {
        if (isTile) reportTileRequest(url, false, e instanceof Error ? e.message : String(e))
        throw e
      }
    }
  }

  const XHR = window.XMLHttpRequest
  if (XHR?.prototype) {
    const origOpen = XHR.prototype.open
    const origSend = XHR.prototype.send
    XHR.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      ;(this as unknown as { __m2Tile?: string }).__m2Tile =
        typeof url === 'string' && looksLikeTile(url) ? url : undefined
      return origOpen.apply(this, [method, url, ...rest] as never)
    }
    XHR.prototype.send = function (...args: unknown[]) {
      const self = this as unknown as { __m2Tile?: string; status?: number }
      const url = self.__m2Tile
      if (url) {
        this.addEventListener('loadend', () => {
          const status = self.status ?? 0
          reportTileRequest(url, status >= 200 && status < 400, status ? `HTTP ${status}` : 'network error')
        })
      }
      return origSend.apply(this, args as never)
    }
  }
}

/** 卸载（测试用；window.fetch 的包装会被还原） */
export function uninstallTileNetworkHook() {
  installed = false
}
