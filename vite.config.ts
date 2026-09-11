import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// 独立演示宿主：npm run dev → http://localhost:5180/
// 端口刻意避开主系统前端（5173）与后端（8080/8090）。

/** 瓦片根目录：默认本目录下 tiles/（目录结构 tiles/raster/{z}/{x}/{y}.jpg），可用 MAP2D_TILES_DIR 覆盖 */
const TILES_DIR = process.env.MAP2D_TILES_DIR
  ? path.resolve(process.env.MAP2D_TILES_DIR)
  : fileURLToPath(new URL('./tiles', import.meta.url))

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pbf': 'application/x-protobuf',
  '.json': 'application/json',
}

/**
 * 本地瓦片直接伺服（开发期）：
 *   /tiles/raster/12/3423/1665.jpg → <TILES_DIR>/raster/12/3423/1665.jpg
 *
 * 为什么需要它：本模块不依赖任何后端的**代码**，但地图显示需要瓦片数据。
 * 把下载好的瓦片包解压到 tiles/ 后，独立宿主即可完全离线运行——
 * 不需要主系统的 C++ 后端、不需要任何服务在跑。
 *
 * 找不到本地文件时不拦截，交给下面的 proxy（借用主系统后端托管的瓦片）；
 * 两者都不可用时页面仍能打开——地图回落缺口底色。
 */
function localTiles(): Plugin {
  return {
    name: 'map-2d-local-tiles',
    configureServer(server) {
      // 启动时把瓦片目录情况打印出来，路径不对时一眼可见
      const raster = path.join(TILES_DIR, 'raster')
      const hasRaster = fs.existsSync(raster)
      const zooms = hasRaster
        ? fs.readdirSync(raster).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b)
        : []
      if (hasRaster && zooms.length) {
        server.config.logger.info(
          `\n  [tiles] 本地瓦片目录: ${TILES_DIR}\n` +
            `  [tiles] 可用层级 z${zooms[0]}–z${zooms[zooms.length - 1]}（${zooms.length} 级）\n`,
        )
      } else {
        server.config.logger.warn(
          `\n  [tiles] 未找到瓦片：${raster}\n` +
            `  [tiles] 地图仍可打开，但底图为空（缺口底色）；把瓦片包解压到 ${TILES_DIR} 即可离线出图\n` +
            `  [tiles] 或用 MAP2D_TILES_DIR 指向已有瓦片目录\n`,
        )
      }

      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        if (!url.startsWith('/tiles/')) return next()
        const rel = decodeURIComponent(url.slice('/tiles/'.length))
        if (!rel || rel.includes('..')) return next()
        const file = path.join(TILES_DIR, rel)
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) return next()      // 本地没有 → 交给 proxy / 回落
          res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
          res.setHeader('Content-Length', String(st.size))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          fs.createReadStream(file).pipe(res)
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localTiles()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: false,
    // 本地 tiles/ 没有的瓦片才走这里：借用主系统后端托管的瓦片（后端未启动则请求失败，地图回落缺口底色）
    proxy: {
      '/tiles': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
})
