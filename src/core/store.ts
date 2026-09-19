// 地图模块 · 模块内 UI 状态（自持 store，不与应用业务 store 混用）
import { create } from 'zustand'
import { ALL_LAYER_GROUPS, LayerManager, type LayerGroup } from '../render/LayerManager'
import { MAP_OPTIONS, type MapControlKey } from './options'
import type { ControlAnchor } from './controls'
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
  /** 当前主题（日间/夜间/高对比，M2-CTRL-13） */
  theme: 'day' | 'night' | 'contrast'
  /** 网格类型（无/经纬网/UTM 方格，M2-MAP-08） */
  grid: 'none' | 'graticule' | 'utm'
  /** 地图控件显示状态（需求 M2-CTRL-01：初值取 MAP_OPTIONS.controls，通常全不显示） */
  controls: Record<MapControlKey, boolean>
  /**
   * 每个控件的**落位**（2026-09-18 新增）：`{ anchor, offset }`。
   *
   * 缺省空表 = 各控件用自己内置的角（见 `core/controls.ts` 的 POSITION 与各 UI 组件）。
   * 宿主用 `mapCommands.configureControls([...])` 覆盖 —— 需求方要求"可配置显隐与位置"。
   */
  controlLayout: Partial<Record<MapControlKey, { anchor?: ControlAnchor; offset?: [number, number] }>>
  /** 鼠标所在经纬度（coords 控件显示用；未开启也在后台更新，宿主可读） */
  pointer: { lng: number; lat: number } | null

  toggleClearMode(): void
  setClearMode(v: boolean): void
  setActiveTool(t: MapToolKey): void
  toggleLayersPanel(): void
  setLayersPanel(open: boolean): void
  toggleGroup(g: LayerGroup): void
  setViewport(v: Partial<MapViewport>): void
  setDisplayMode(m: string): void
  setTheme(t: 'day' | 'night' | 'contrast'): void
  setGrid(g: 'none' | 'graticule' | 'utm'): void
  setControls(v: Partial<Record<MapControlKey, boolean>>): void
  setControlLayout(v: MapUiState['controlLayout']): void
  setPointer(p: { lng: number; lat: number } | null): void
}

export const useMapUiStore = create<MapUiState>((set, get) => ({
  clearMode: false,
  activeTool: 'select',
  layersOpen: false,
  hiddenGroups: LayerManager.hiddenGroups(),
  viewport: { lng: 0, lat: 0, zoom: 0, bearing: 0 },
  displayMode: '',
  theme: 'night',
  grid: 'none',
  controls: { ...MAP_OPTIONS.controls },
  controlLayout: {},
  pointer: null,

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
  setTheme(t) {
    set({ theme: t })
  },
  setGrid(g) {
    set({ grid: g })
  },
  setDisplayMode(m) {
    set({ displayMode: m })
  },
  setControls(v) {
    set({ controls: { ...get().controls, ...v } })
  },
  setControlLayout(v) {
    set({ controlLayout: { ...v } })
  },
  setPointer(p) {
    set({ pointer: p })
  },
}))

/** 图层分组清单（供面板渲染；顺序固定） */
export const LAYER_GROUPS = ALL_LAYER_GROUPS
