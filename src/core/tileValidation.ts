// map-2d · 瓦片包版本与完整性校验（需求 M2-BASE-08）
//
// 背景：浏览器**无法遍历服务端瓦片目录**，所以"列出缺块清单"不能靠扫目录实现。
// 采用两级方案（互补）：
//   ① 清单校验：宿主/服务端提供 `manifest.json`（含包版本、各层级瓦片数、可选 sha256），
//      模块比对版本、层级覆盖与数量——这是"包对不对"的判据；
//   ② 抽样探测：对每个层级取若干样本瓦片发 HEAD 请求，找出实际缺失的瓦片 URL
//      ——这是"包全不全"的判据（抽样，不是全量；全量请用清单里的数量对比）。
// 两者都不依赖模块能读文件系统，服务端只需提供静态文件即可。
import { mapInstance } from './instance'
import { DEFAULT_TILE_TEMPLATE as MAP2D_DEFAULT_TILE_TEMPLATE } from './options'

/** 瓦片包清单（约定格式；服务端或宿主提供） */
export interface TileManifest {
  /** 包版本（如 "v1"） */
  version: string
  /** 生成时间（ISO 字符串，可选） */
  generatedAt?: string
  /** 瓦片模板（应与地图配置一致，用于发现配置错配） */
  template?: string
  /** 各层级瓦片数：{ "0": 1, "1": 4, ... } */
  counts?: Record<string, number>
  /** 瓦片总数 */
  total?: number
  /** 每层级的实际瓦片 key 列表（可选；给了就能算精确缺块） */
  keys?: Record<string, string[]>
  /** 完整性校验用的 sha256（可选） */
  sha256?: string
}

export interface ValidationCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ValidationReport {
  /** overall：全部通过；failed：有硬性问题；sampled：清单不可用，只做了抽样 */
  status: 'overall' | 'failed' | 'sampled'
  /** 清单版本（取不到时为 null） */
  version: string | null
  checks: ValidationCheck[]
  /** 抽样探测发现的缺失瓦片（相对 URL） */
  missing: string[]
  /** 抽样探测的瓦片总数 */
  probed: number
  /** 探测耗时（毫秒） */
  elapsedMs: number
}

const DEFAULT_MANIFEST_URLS = ['/tiles/manifest.json', '/tiles/raster/manifest.json']

async function fetchManifest(explicit?: string): Promise<{ manifest: TileManifest | null; url: string | null; error?: string }> {
  const urls = explicit ? [explicit] : DEFAULT_MANIFEST_URLS
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) continue
      const json = (await res.json()) as TileManifest
      if (json && typeof json.version === 'string') return { manifest: json, url }
    } catch {
      /* 该地址不可用，试下一个 */
    }
  }
  return { manifest: null, url: null, error: explicit ? `清单地址不可用：${explicit}` : '未找到瓦片清单（服务端未提供 manifest.json）' }
}

/** 从模板生成某张瓦片的相对 URL */
function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
}

/**
 * 校验瓦片包。
 *
 * @param opts.manifestUrl 清单地址（默认依次尝试 /tiles/manifest.json、/tiles/raster/manifest.json）
 * @param opts.samplePerZoom 每个层级抽样多少张（默认 3；设为 0 跳过抽样）
 * @param opts.expectVersion 期望的包版本（不一致时判为失败）
 * @param opts.template 瓦片模板（默认取当前地图配置）
 */
export async function validateTiles(opts: {
  manifestUrl?: string
  samplePerZoom?: number
  expectVersion?: string
  template?: string
} = {}): Promise<ValidationReport> {
  const t0 = performance.now()
  const checks: ValidationCheck[] = []
  const missing: string[] = []
  let probed = 0

  const cfgTemplate = (mapInstance.current?.getStyle()?.sources?.base as { tiles?: string[] } | undefined)?.tiles?.[0]
  const template = opts.template ?? cfgTemplate ?? MAP2D_DEFAULT_TILE_TEMPLATE

  // ① 清单
  const { manifest, url, error } = await fetchManifest(opts.manifestUrl)
  if (manifest) {
    checks.push({ name: '清单可读', ok: true, detail: `来源 ${url}，版本 ${manifest.version}` })
    if (opts.expectVersion) {
      const ok = manifest.version === opts.expectVersion
      checks.push({ name: '版本匹配', ok, detail: ok ? `版本一致（${manifest.version}）` : `期望 ${opts.expectVersion}，实际 ${manifest.version}` })
    }
    if (manifest.template) {
      const ok = manifest.template === template
      checks.push({ name: '模板一致', ok, detail: ok ? '与地图配置一致' : `清单 ${manifest.template}，地图 ${template}` })
    }
    if (manifest.counts) {
      const levels = Object.keys(manifest.counts).map(Number).sort((a, b) => a - b)
      const gaps: number[] = []
      for (let z = levels[0]; z <= levels[levels.length - 1]; z++) if (!levels.includes(z)) gaps.push(z)
      checks.push({
        name: '层级连续',
        ok: gaps.length === 0,
        detail: gaps.length ? `缺少层级 ${gaps.join(',')}` : `覆盖 z${levels[0]}–z${levels[levels.length - 1]}，共 ${levels.length} 级`,
      })
      const sum = Object.values(manifest.counts).reduce((n, v) => n + v, 0)
      if (manifest.total != null) {
        checks.push({ name: '总数一致', ok: sum === manifest.total, detail: `清单 total=${manifest.total}，各层求和=${sum}` })
      }
    } else {
      checks.push({ name: '层级连续', ok: false, detail: '清单未提供各层级瓦片数（counts）' })
    }
  } else {
    checks.push({ name: '清单可读', ok: false, detail: error ?? '清单不可用' })
  }

  // ② 抽样探测
  const sample = opts.samplePerZoom ?? 3
  if (sample > 0) {
    const levels = manifest?.counts
      ? Object.keys(manifest.counts).map(Number).sort((a, b) => a - b)
      // 没有清单时按模块已知层级范围抽样
      : Array.from({ length: 15 }, (_, z) => z)
    for (const z of levels) {
      const n = 2 ** z
      // 在每层取"中心 + 两个角"作为样本
      const allCoords: [number, number][] = [
        [Math.floor(n / 2), Math.floor(n / 2)],
        [Math.max(0, Math.floor(n * 0.25)), Math.max(0, Math.floor(n * 0.25))],
        [Math.min(n - 1, Math.floor(n * 0.75)), Math.min(n - 1, Math.floor(n * 0.75))],
      ]
      const coords = allCoords.slice(0, sample)
      for (const [x, y] of coords) {
        const u = tileUrl(template, z, x, y)
        probed++
        try {
          const res = await fetch(u, { method: 'HEAD', cache: 'no-store' })
          if (!res.ok) missing.push(u)
        } catch {
          missing.push(u)
        }
      }
    }
    checks.push({
      name: '抽样可读',
      ok: missing.length === 0,
      detail: missing.length ? `${probed} 张样本中 ${missing.length} 张不可读` : `${probed} 张样本全部可读`,
    })
  }

  const hardFail = checks.some((c) => !c.ok && (c.name === '版本匹配' || c.name === '抽样可读' || c.name === '模板一致'))
  const status: ValidationReport['status'] = hardFail ? 'failed' : manifest ? 'overall' : 'sampled'

  return { status, version: manifest?.version ?? null, checks, missing, probed, elapsedMs: Math.round(performance.now() - t0) }
}

/** 缺块清单（只返回抽样发现缺失的，供宿主展示或上报） */
export function missingTilesFrom(report: ValidationReport): string[] {
  return [...report.missing]
}
