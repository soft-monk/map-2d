import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// 独立演示宿主：npm run dev → http://localhost:5180/
// 端口刻意避开主系统前端（5173）与后端（8080/8090）。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '0.0.0.0',
    port: 5180,
    strictPort: false,
    // 本地瓦片由主系统后端托管；独立运行时若后端在 8080，这里做一次代理，
    // 未启动后端也不会报错——地图回落缺口底色（见 ui/MapView.tsx 的 rasterStyle）。
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
