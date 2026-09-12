// map-2d 最小接入示例（需求 M2-API-14）
//
// 用途：**不依赖任何业务后端**，拷到自己的 React + Vite（或 Next/webpack）项目里即可跑起来。
// 看这一份就能接入；更细的签名与错误约定见 doc/接口文档.md。
//
// 运行前提
//   1) 依赖：react / react-dom / maplibre-gl / zustand（与模块一致）
//   2) 底图：把瓦片放到服务可访问的路径（默认模板 /tiles/raster/{z}/{x}/{y}.jpg），
//      或直接传在线样式 URL（见下面第二种配置）
//   3) 引入模块样式：无需——模块自带内联样式，控件的样式由模块自己注入
import React from 'react'
import { MapView, MapDraw, mapCommands } from '@map2d'
import type { MapData } from '@map2d'

/** ① 地图数据：配置 +（可选）图元。缺字段按约定降级，不会报错 */
const data: MapData = {
  config: {
    center: [116.3974, 39.9093],   // 北京
    zoom: 12,
    minZoom: 3,
    maxZoom: 16,
    // 本地瓦片（默认）；换成在线样式就写 styleUrl
    tileUrlTemplate: '/tiles/raster/{z}/{x}/{y}.jpg',
    attribution: '',
  },
  // 业务数据（都可不传；这里给最小示例）
  targets: [
    { id: 'T-1', lng: 116.404, lat: 39.915, label: '目标 001', threat: 'high' },
    { id: 'T-2', lng: 116.380, lat: 39.900, label: '目标 002', threat: 'mid' },
  ],
  uavs: [
    { id: 'U-1', lng: 116.42, lat: 39.93, label: '无人机 01' },
  ],
}

export const MinimalExample: React.FC = () => {
  // ② 等地图可画之后再灌图元（isReady 的语义是"图层已建立"，不是"实例已创建"）
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (!mapCommands.isReady()) return
      window.clearInterval(timer)

      // 用绘制接口画一个区域与一条航线（坐标显式，不依赖业务数据结构）
      MapDraw.set('area', [
        { id: 'A-1', polygon: [[116.36, 39.90], [116.42, 39.90], [116.42, 39.94], [116.36, 39.94]], label: '任务区域' },
      ])
      MapDraw.set('route', [
        { id: 'R-1', points: [[116.36, 39.95], [116.40, 39.96], [116.44, 39.95]], dashed: true },
      ])

      // 控件默认全部不显示；需要哪个开哪个
      mapCommands.showControls(['scale', 'coords'])

      // 图元点击回调（宿主据此联动业务面板）
      MapDraw.on('click', (e) => console.log('点击了图元', e.kind, e.id))
    }, 100)
    return () => window.clearInterval(timer)
  }, [])

  return (
    // ③ 地图容器：给一个撑满父级的容器即可（模块内部自建 MapLibre 实例）
    <div style={{ position: 'fixed', inset: 0 }}>
      <MapView data={data} />
    </div>
  )
}

/** 换在线样式底图只需改配置（不用动其它代码） */
export const onlineStyleData: MapData = {
  config: {
    center: [116.3974, 39.9093],
    zoom: 5,
    styleUrl: 'https://demotiles.maplibre.org/style.json',
  },
}

/** 常用操作速查（复制即用） */
export const cheatSheet = {
  view: () => mapCommands.setView(116.3974, 39.9093, 12, 600),
  focus: () => mapCommands.focus(116.404, 39.915, 14),
  reset: () => mapCommands.resetView(data.config),
  viewport: () => mapCommands.getViewport(),
  addPoint: () => MapDraw.add('target', { id: 'T-9', lng: 116.41, lat: 39.92 }),
  hideAll: () => MapDraw.hideAll(),
  batch: () => MapDraw.batch(() => {
    for (let i = 0; i < 1000; i++) MapDraw.add('drone', { id: `U-${i}`, lng: 116.3 + i * 1e-4, lat: 39.85 })
  }),
  measure: () => mapCommands.setDrawMode('measure-line'),
  edit: () => mapCommands.editPrimitive('area', 'A-1'),
  export: async () => {
    const state = await mapCommands.exportViewState()
    const img = await mapCommands.exportImage()
    return { state, img }
  },
  stats: () => mapCommands.getStats(),
}
