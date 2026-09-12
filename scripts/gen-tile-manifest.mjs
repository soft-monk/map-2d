// 生成瓦片包清单 tiles/raster/manifest.json（需求 M2-BASE-08 的数据来源）
//
// 用法（在 map-2d 目录下）：
//   node scripts/gen-tile-manifest.mjs [瓦片根目录] [版本号]
//   例：node scripts/gen-tile-manifest.mjs ./tiles/raster v1
//
// 为什么用脚本而不是后端接口：瓦片是**静态文件**托管的（Nginx / 静态中间件 / Vite 插件），
// 清单也应当是静态文件；由脚本在打包/交付时生成，比后端每次启动扫目录更简单可靠。
// 前端 `mapCommands.validateTiles()` 会把这份清单与"抽样探测"结合，给出可用性结论。
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(process.argv[2] ?? './tiles/raster')
const version = process.argv[3] ?? 'v1'

/** 递归列出某层级下的全部瓦片相对路径 */
function listTiles(dir) {
  const out = []
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full, `${prefix}${name}/`)
      else out.push(`${prefix}${name}`)
    }
  }
  walk(dir, '')
  return out
}

const counts = {}
const keys = {}
let total = 0
const hash = createHash('sha256')

for (const z of readdirSync(root)) {
  // 只认数字命名的层级目录（根下还可能有 .gitkeep、manifest.json 等文件）
  if (!/^\d+$/.test(z)) continue
  const zDir = join(root, z)
  if (!statSync(zDir).isDirectory()) continue
  const tiles = listTiles(zDir).sort()
  counts[z] = tiles.length
  keys[z] = tiles
  total += tiles.length
  // 逐层累计哈希（顺序稳定，便于跨机器比对）
  for (const t of tiles) hash.update(`${z}/${t}\n`)
  console.log(`  z${z}: ${tiles.length} 张`)
}

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  template: '/tiles/raster/{z}/{x}/{y}.jpg',
  counts,
  total,
  keys,
  sha256: hash.digest('hex'),
}

const outPath = join(root, 'manifest.json')
writeFileSync(outPath, JSON.stringify(manifest), 'utf8')
console.log(`\n清单已写入 ${outPath}`)
console.log(`  版本 ${version} · 层级 ${Object.keys(counts).length} 级 · 瓦片 ${total} 张 · sha256 ${manifest.sha256.slice(0, 16)}…`)
