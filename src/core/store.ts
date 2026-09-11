// 地图模块 · 模块内 UI 状态（自持 store，不与应用业务 store 混用）
import { create } from 'zustand'
import { ALL_LAYER_GROUPS, LayerManager, type LayerGroup } from '../render/LayerManager'
import type { MapToolKey, MapViewport } from './types'

export interface MapUiState {
  /** 清屏模式：只保留地图与地图上的绘制物（以及应用框架的左右/底部栏，由应用决定） */
  clearMode: boolean
  /** 当前激活的地图工具 */
  activeTool: MapToolKey
  /** 图层开关面板是否展开 */
  layersOpen: boolean
  /** 被关闭的图层分组 */
  hiddenGroups: LayerGroup[]
  /** 当前视口（指北针/比例尺/调试用） */
  viewport: MapViewport
  /** 显示模式名称（由应用按阶段写入，模块只负责展示） */
  displayMode: string

  toggleClearMode(): void
  setClearMode(v: boolean): void
  setActiveTool(t: MapToolKey): void
  toggleLayersPanel(): void
  setLayersPanel(open: boolean): void
  toggleGroup(g: LayerGroup): void
  setViewport(v: Partial<MapViewport>): void
  setDisplayMode(m: string): void
}

export const useMapUiStore = create<MapUiState>((set, get) => ({
  clearMode: false,
  activeTool: 'select',
  layersOpen: false,
  hiddenGroups: LayerManager.hiddenGroups(),
  viewport: { lng: 0, lat: 0, zoom: 0, bearing: 0 },
  displayMode: '',

  toggleClearMode() {
    const next = !get().clearMode
    // 进入清屏时收起图层面板，避免遮挡地图
    set({ clearMode: next, layersOpen: next ? false : get().layersOpen, activeTool: next ? 'select' : get().activeTool })
  },
  setClearMode(v) {
    set({ clearMode: v, layersOpen: false })
  },
  setActiveTool(t) {
    set({ activeTool: t })
  },
  toggleLayersPanel() {
    set({ layersOpen: !get().layersOpen })
  },
  setLayersPanel(open) {
    set({ layersOpen: open })
  },
  toggleGroup(g) {
    const visible = LayerManager.isGroupVisible(g)
    LayerManager.setGroupVisible(g, !visible)
    set({ hiddenGroups: LayerManager.hiddenGroups() })
  },
  setViewport(v) {
    set({ viewport: { ...get().viewport, ...v } })
  },
  setDisplayMode(m) {
    set({ displayMode: m })
  },
}))

/** 图层分组清单（供面板渲染；顺序固定） */
export const LAYER_GROUPS = ALL_LAYER_GROUPS
