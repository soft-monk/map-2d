// 双实例验证页（一次性，验证后删除；M2-NFR-08 多实例隔离）
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MapView, MapDraw, mapCommands, listMapInstances, setActiveInstance } from '../index'
import { DEMO_BASEMAPS, DEMO_BASEMAP_DEFS, DEMO_SNAPSHOT } from './demo-data'
import './standalone.css'

const config = DEMO_BASEMAPS.local.config
const dataA = { config, phase: 'T4' as const, targets: [], groups: [], uavs: [], edges: [], topology: null, track: [] }
const dataB = { config: { ...config, center: [121.4737, 31.2304] as [number, number], zoom: 10 }, phase: 'T4' as const, targets: [], groups: [], uavs: [], edges: [], topology: null, track: [] }

const App: React.FC = () => (
  <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
    <div style={{ flex: 1, position: 'relative' }}>
      <MapView data={dataA as never} instanceId="A" />
    </div>
    <div style={{ flex: 1, position: 'relative' }}>
      <MapView data={dataB as never} instanceId="B" />
    </div>
  </div>
)

// 把待验证的接口挂到 window，供 CDP 脚本调用
;(window as unknown as Record<string, unknown>).__mi = {
  listMapInstances, setActiveInstance, mapCommands, MapDraw, DEMO_SNAPSHOT, DEMO_BASEMAP_DEFS, DEMO_BASEMAPS,
}

createRoot(document.getElementById('root')!).render(<App />)
