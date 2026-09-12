// LayerManager.ts —— MapLibre 原生动态图层管理（地图模块内部实现）
//
// 图层：区域多边形 / 链路 / 集群 / 目标 / 无人机 / 扫描热点 / 轨迹
// 增量原则：source.setData() 而非重建图层（TRD 性能设计要点）。
// 分组显隐：setGroupVisible()，满足 MAP-04「多图层可独立开关」。
import type { Map as MlMap } from 'maplibre-gl'
import type { Group, LinkEdge, Phase, ScenarioKey, Target, TargetTrackPoint, UavPosEvent } from '../core/types'

const SRC = {
  area: 'src-area',
  link: 'src-link',
  group: 'src-group',
  target: 'src-target',
  uav: 'src-uav',
  scan: 'src-scan',
  track: 'src-track',
  trail: 'src-trail',
  pulse: 'src-pulse',
  mark: 'src-mark',
  route: 'src-route',
  shape: 'src-shape',
  annulus: 'src-annulus',
}

const LYR = {
  areaFill: 'lyr-area-fill',
  areaLine: 'lyr-area-line',
  link: 'lyr-link',
  linkGlow: 'lyr-link-glow',
  group: 'lyr-group',
  groupLabel: 'lyr-group-label',
  target: 'lyr-target',
  targetGlow: 'lyr-target-glow',
  targetLabel: 'lyr-target-label',
  uav: 'lyr-uav',
  uavGlow: 'lyr-uav-glow',
  uavLabel: 'lyr-uav-label',
  scan: 'lyr-scan',
  track: 'lyr-track',
  trail: 'lyr-trail',
  pulse: 'lyr-pulse',
  mark: 'lyr-mark',
  markLabel: 'lyr-mark-label',
  route: 'lyr-route',
  routeDashed: 'lyr-route-dashed',
  routeGlow: 'lyr-route-glow',
  shapeFill: 'lyr-shape-fill',
  shapeLine: 'lyr-shape-line',
  shapeLineDashed: 'lyr-shape-line-dashed',
  annulus: 'lyr-annulus',
  annulusDashed: 'lyr-annulus-dashed',
}

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] })

/** 可独立开关的图层分组（对外公开，供图层开关面板使用） */
export type LayerGroup = 'area' | 'pulse' | 'scan' | 'link' | 'group' | 'track' | 'trail' | 'target' | 'uav' | 'mark' | 'route' | 'annulus'

export const LAYER_GROUP_LABELS: Record<LayerGroup, string> = {
  area: '任务区域',
  group: '集群编组',
  uav: '无人机/航迹',
  target: '目标/锁定框',
  link: '数据链路',
  scan: '扫描覆盖',
  track: '目标轨迹',
  trail: '飞行尾迹',
  pulse: '脉冲标记',
  mark: '标注/标记',
  route: '航线/图形区',
  annulus: '圈层/参考线',
}

const GROUP_LAYERS: Record<LayerGroup, string[]> = {
  area: [LYR.areaFill, LYR.areaLine],
  pulse: [LYR.pulse],
  scan: [LYR.scan],
  link: [LYR.linkGlow, LYR.link],
  group: [LYR.group, LYR.groupLabel],
  track: [LYR.track],
  trail: [LYR.trail],
  target: [LYR.targetGlow, LYR.target, LYR.targetLabel],
  uav: [LYR.uavGlow, LYR.uav, LYR.uavLabel],
  mark: [LYR.mark, LYR.markLabel],
  route: [LYR.routeGlow, LYR.route, LYR.routeDashed, LYR.shapeFill, LYR.shapeLine, LYR.shapeLineDashed],
  annulus: [LYR.annulus, LYR.annulusDashed],
}

export const ALL_LAYER_GROUPS = Object.keys(GROUP_LAYERS) as LayerGroup[]

// 航迹历史（用于尾迹）
const trailHistory: Record<string, [number, number][]> = {}

export class LayerManager {
  private static map: MlMap | null = null
  private static scenario: ScenarioKey = 'scenario-1'
  private static phase: Phase = 'T0'
  private static pulseTimer: number | null = null
  private static pulseSeeds: { lng: number; lat: number; color: string; id?: string }[] = []
  /** 被用户关掉的图层分组（跨 init 保留，重新加载样式后由 applyVisibility 恢复） */
  private static hidden = new Set<LayerGroup>()
  /** 各分组的整体透明度（M2-CTRL-12）；跨样式重建保留 */
  private static opacity = new Map<LayerGroup, number>()
  /** 各图层原始的透明度数值（乘系数前的基准），避免反复相乘 */
  private static baseOpacity = new Map<string, number>()

  /** 图层分组显隐（MAP-04：多图层可独立开关） */
  static setGroupVisible(group: LayerGroup, visible: boolean) {
    if (visible) this.hidden.delete(group)
    else this.hidden.add(group)
    this.applyVisibility()
  }

  static isGroupVisible(group: LayerGroup) {
    return !this.hidden.has(group)
  }

  static hiddenGroups(): LayerGroup[] {
    return [...this.hidden]
  }

  /** 把当前显隐状态应用到已存在的图层（幂等，可在 init 后调用） */
  static applyVisibility() {
    const map = this.map
    if (!map) return
    const keep = this.phaseVisibleLayers()
    for (const g of ALL_LAYER_GROUPS) {
      const groupOn = !this.hidden.has(g)
      for (const id of GROUP_LAYERS[g]) {
        if (!map.getLayer(id)) continue
        // 最终可见 = 分组开关 **且** 阶段规则没把它关掉
        const vis = groupOn && (!keep || keep.has(id)) ? 'visible' : 'none'
        map.setLayoutProperty(id, 'visibility', vis)
      }
    }
  }

  /**
   * 当前阶段允许显示的图层集合。
   * 说明：阶段规则与分组开关是两个正交的维度——阶段决定"这个阶段该不该有这类图层"，
   * 分组开关决定"用户想不想看"。最终可见性取两者交集（见 applyVisibility）。
   */
  private static phaseVisibleLayers(): Set<string> | null {
    const map = this.map
    if (!map) return null
    const p = this.phase
    const recon = p === 'T3' || p === 'T4' || p === 'T5' || p === 'T6'
    const showTarget = p !== 'T0' && p !== 'T1' && p !== 'T2'
    const showGroup = p === 'T1' || p === 'T2' || p === 'T3'
    const showLink = p !== 'T0' && p !== 'T1'
    const on: string[] = []
    // 与阶段无关的图层（任务区域、标注、航线/图形区）始终按分组开关显示
    on.push(...GROUP_LAYERS.area, ...GROUP_LAYERS.mark, ...GROUP_LAYERS.route, ...GROUP_LAYERS.annulus)
    if (recon) on.push(LYR.scan)
    if (recon || p === 'T7') on.push(LYR.trail)
    // 无人机位置：侦察阶段起显示（T3–T7）。
    // 修正：此前该组从未被阶段规则打开，导致 setUavs 灌入的实时位置不显示
    //（与《技术需求文档》MAP-02「集群动态图层」的要求不符）。
    if (recon || p === 'T7') on.push(LYR.uav, LYR.uavGlow, LYR.uavLabel)
    if (recon && this.scenario === 'scenario-2') on.push(LYR.track)
    if (showTarget) on.push(LYR.target, LYR.targetLabel, LYR.targetGlow, LYR.pulse)
    if (showLink) on.push(LYR.link, LYR.linkGlow)
    if (showGroup) on.push(LYR.group, LYR.groupLabel)
    return new Set(on)
  }

  static init(map: MlMap) {
    this.map = map
    const add = (id: string, data: GeoJSON.FeatureCollection) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data })
    }
    add(SRC.area, this.areaData())
    add(SRC.link, emptyFC())
    add(SRC.group, emptyFC())
    add(SRC.target, emptyFC())
    add(SRC.uav, emptyFC())
    add(SRC.scan, emptyFC())
    add(SRC.track, emptyFC())
    add(SRC.trail, emptyFC())
    add(SRC.pulse, emptyFC())
    add(SRC.mark, emptyFC())
    add(SRC.route, emptyFC())
    add(SRC.shape, emptyFC())
    add(SRC.annulus, emptyFC())

    // ---- 区域多边形（任务分区） ----
    map.addLayer({
      id: LYR.areaFill, type: 'fill', source: SRC.area,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 },
    })
    map.addLayer({
      id: LYR.areaLine, type: 'line', source: SRC.area,
      paint: { 'line-color': ['get', 'color'], 'line-width': 1.4, 'line-dasharray': [4, 3], 'line-opacity': 0.8 },
    })

    // ---- 脉冲圈（无人机/目标外围扩散环，动画由 rAF 驱动） ----
    map.addLayer({
      id: LYR.pulse, type: 'circle', source: SRC.pulse,
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': ['get', 'o'],
      },
    })

    // ---- 扫描热点（同心圆，侦察阶段） ----
    map.addLayer({
      id: LYR.scan, type: 'circle', source: SRC.scan,
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.10,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.55,
      },
    })

    // ---- 链路（外发光 + 实线） ----
    map.addLayer({
      id: LYR.linkGlow, type: 'line', source: SRC.link,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 6,
        'line-opacity': 0.14,
        'line-blur': 3,
      },
    })
    // ---- 链路（主线） ----
    map.addLayer({
      id: LYR.link, type: 'line', source: SRC.link,
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 1.8,
        'line-opacity': 0.85,
        'line-dasharray': ['case', ['==', ['get', 'state'], 'green'], ['literal', [1, 0]], ['literal', [3, 2]]],
      },
    })

    // ---- 集群区域 ----
    map.addLayer({
      id: LYR.group, type: 'circle', source: SRC.group,
      paint: {
        'circle-radius': 26,
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.12,
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 1.2,
        'circle-stroke-opacity': 0.6,
      },
    })
    map.addLayer({
      id: LYR.groupLabel, type: 'symbol', source: SRC.group,
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11.5,
        'text-offset': [0, 1.9],
        'text-anchor': 'top',
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#cfe6ff', 'text-halo-color': 'rgba(5,10,20,.9)', 'text-halo-width': 2.2 },
    })

    // ---- 轨迹回溯 ----
    map.addLayer({
      id: LYR.track, type: 'line', source: SRC.track,
      paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
    })

    // ---- 无人机尾迹 ----
    map.addLayer({
      id: LYR.trail, type: 'line', source: SRC.trail,
      paint: { 'line-color': '#22d3ee', 'line-width': 1.2, 'line-opacity': 0.45 },
    })

    // ---- 目标（外光晕 + 环形锁定框 + 标签） ----
    map.addLayer({
      id: LYR.targetGlow, type: 'circle', source: SRC.target,
      paint: {
        'circle-radius': ['case', ['==', ['get', 'selected'], true], 26, 19],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.16,
        'circle-blur': 1,
      },
    })
    map.addLayer({
      id: LYR.target, type: 'circle', source: SRC.target,
      paint: {
        'circle-radius': ['case', ['==', ['get', 'selected'], true], 15, 11],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 3, 2],
      },
    })
    map.addLayer({
      id: LYR.targetLabel, type: 'symbol', source: SRC.target,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-offset': [0, 1.5],
        'text-anchor': 'top',
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': 'rgba(5,10,20,.85)',
        'text-halo-width': 2,
      },
    })

    // ---- 无人机 ----
    map.addLayer({
      id: LYR.uav, type: 'circle', source: SRC.uav,
      paint: {
        'circle-radius': 5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#e8f1ff',
        'circle-stroke-width': 1,
      },
    })
    map.addLayer({
      id: LYR.uavLabel, type: 'symbol', source: SRC.uav,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 10.5,
        'text-offset': [0, -1.4],
        'text-anchor': 'bottom',
        'text-allow-overlap': false,      // 避让：重叠的标签由渲染器自动隐藏（M2-DRAW-11）
        'text-ignore-placement': false,
      },
      paint: { 'text-color': '#9fb3d1', 'text-halo-color': 'rgba(5,10,20,.85)', 'text-halo-width': 1.6 },
    })

    // ---- 通用标注 / 标记（绘图 API 驱动的自由图元） ----
    map.addLayer({
      id: LYR.mark, type: 'circle', source: SRC.mark,
      paint: {
        'circle-radius': ['coalesce', ['get', 'r'], 4],
        'circle-color': ['coalesce', ['get', 'color'], '#22d3ee'],
        'circle-stroke-color': 'rgba(232,241,255,.75)',
        'circle-stroke-width': 1,
      },
    })
    map.addLayer({
      id: LYR.markLabel, type: 'symbol', source: SRC.mark,
      layout: {
        'text-field': ['coalesce', ['get', 'text'], ''],
        'text-size': ['coalesce', ['get', 'size'], 11],
        'text-offset': [0, -1.3],
        'text-anchor': 'bottom',
        'text-allow-overlap': false,      // 避让：重叠的标签由渲染器自动隐藏（M2-DRAW-11）
        'text-ignore-placement': false,
      },
      paint: { 'text-color': ['coalesce', ['get', 'color'], '#cfe3f5'], 'text-halo-color': 'rgba(5,10,20,.85)', 'text-halo-width': 1.8 },
    })

    // ---- 无人机航线（需求 M2-DRAW-01：航线；发光底 + 实/虚线航线） ----
    map.addLayer({
      id: LYR.routeGlow, type: 'line', source: SRC.route,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#22d3ee'],
        'line-width': 4.5, 'line-opacity': 0.18, 'line-blur': 3,
      },
    })
    // 实线航线 + 虚线航线：MapLibre 的 line-dasharray **不支持数据表达式**，
    // 因此用"同一数据源 + filter 分流 + 常量 dasharray"两套图层实现按图元切换虚实线。
    map.addLayer({
      id: LYR.route, type: 'line', source: SRC.route,
      filter: ['!=', ['get', 'dashed'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#22d3ee'],
        'line-width': 1.6,
        'line-opacity': 0.95,
      },
    })
    map.addLayer({
      id: LYR.routeDashed, type: 'line', source: SRC.route,
      filter: ['==', ['get', 'dashed'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#22d3ee'],
        'line-width': 1.6,
        'line-opacity': 0.95,
        'line-dasharray': [6, 4],
      },
    })

    // ---- 圆形 / 椭圆形区域（需求 M2-DRAW-01：圆形、椭圆区域） ----
    map.addLayer({
      id: LYR.shapeFill, type: 'fill', source: SRC.shape,
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], '#3b82f6'],
        'fill-opacity': ['coalesce', ['get', 'opacity'], 0.12],
      },
    })
    // 同航线：实/虚两套图层（dasharray 不支持数据表达式）
    map.addLayer({
      id: LYR.shapeLine, type: 'line', source: SRC.shape,
      filter: ['!=', ['get', 'dashed'], true],
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#3b82f6'],
        'line-width': ['coalesce', ['get', 'weight'], 1.4],
        'line-opacity': 0.9,
      },
    })
    map.addLayer({
      id: LYR.shapeLineDashed, type: 'line', source: SRC.shape,
      filter: ['==', ['get', 'dashed'], true],
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#3b82f6'],
        'line-width': ['coalesce', ['get', 'weight'], 1.4],
        'line-opacity': 0.9,
        'line-dasharray': [4, 3],
      },
    })

    // ---- 圈层类图元（需求 M2-DRAW-09：距离环 / 方位线 / 方位圈 / 九宫格） ----
    // 实/虚两套图层（与航线同理：line-dasharray 不支持数据表达式，只能用 filter 分流）
    map.addLayer({
      id: LYR.annulus, type: 'line', source: SRC.annulus,
      filter: ['!=', ['get', 'dashed'], true],
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#38bdf8'],
        'line-width': ['coalesce', ['get', 'weight'], 1.2],
        'line-opacity': 0.85,
      },
    })
    map.addLayer({
      id: LYR.annulusDashed, type: 'line', source: SRC.annulus,
      filter: ['==', ['get', 'dashed'], true],
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#38bdf8'],
        'line-width': ['coalesce', ['get', 'weight'], 1.2],
        'line-opacity': 0.85,
        'line-dasharray': [4, 3],
      },
    })

    this.startPulse()
  }

  // ---------------------------------------------------------------- 脉冲动效
  /** 无人机/目标外围扩散脉冲环（rAF 驱动，半径与透明度随时间变化） */
  private static startPulse() {
    if (this.pulseTimer !== null) return
    const tick = () => {
      const map = this.map
      if (!map) return
      const src = map.getSource(SRC.pulse) as maplibregl.GeoJSONSource | undefined
      // 无脉冲对象时不做无谓更新
      if (src && this.pulseSeeds.length > 0) {
        const t = (performance.now() % 2000) / 2000   // 0..1 周期 2s
        const feats: GeoJSON.Feature[] = []
        for (const s of this.pulseSeeds) {
          for (let k = 0; k < 2; k++) {
            const phase = (t + k * 0.5) % 1
            feats.push({
              type: 'Feature',
              properties: {
                id: s.id,
                r: 5 + phase * 26,
                o: (1 - phase) * 0.75,
                color: s.color,
              },
              geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
            })
          }
        }
        src.setData({ type: 'FeatureCollection', features: feats } as never)
      }
      this.pulseTimer = window.requestAnimationFrame(tick)
    }
    this.pulseTimer = window.requestAnimationFrame(tick)
  }

  static stopPulse() {
    if (this.pulseTimer !== null) {
      window.cancelAnimationFrame(this.pulseTimer)
      this.pulseTimer = null
    }
  }

  /** 更新脉冲种子（目标点） */
  private static setPulseSeeds(seeds: { lng: number; lat: number; color: string; id?: string }[]) {
    this.pulseSeeds = seeds
    if (seeds.length === 0 && this.map) {
      const src = this.map.getSource(SRC.pulse) as maplibregl.GeoJSONSource | undefined
      src?.setData({ type: 'FeatureCollection', features: [] } as never)
    }
  }

  // ---------------------------------------------------------------- 区域
  /** 任务分区：按场景给出 A/B/C 等分区多边形（演示数据） */
  private static areaData(): GeoJSON.FeatureCollection {
    const s1 = this.scenario !== 'scenario-2'
    const c: [number, number] = s1 ? [116.3974, 39.9093] : [121.4737, 31.2304]
    const ring = (dlng: number, dlat: number, r: number): [number, number][] => {
      const pts: [number, number][] = []
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2
        pts.push([c[0] + dlng + Math.cos(a) * r, c[1] + dlat + Math.sin(a) * r * 0.75])
      }
      return pts
    }
    const feats: GeoJSON.Feature[] = s1
      ? [
          { type: 'Feature', properties: { name: 'A 区域', color: '#3b82f6' }, geometry: { type: 'Polygon', coordinates: [ring(-0.075, 0.012, 0.045)] } },
          { type: 'Feature', properties: { name: 'B 区域', color: '#22c55e' }, geometry: { type: 'Polygon', coordinates: [ring(0.062, 0.030, 0.040)] } },
          { type: 'Feature', properties: { name: 'C 区域', color: '#ef4444' }, geometry: { type: 'Polygon', coordinates: [ring(0.008, -0.052, 0.036)] } },
          { type: 'Feature', properties: { name: '敌方潜在部署区', color: '#f59e0b' }, geometry: { type: 'Polygon', coordinates: [ring(-0.010, 0.062, 0.033)] } },
        ]
      : [
          { type: 'Feature', properties: { name: '西侧重点侦察区', color: '#f59e0b' }, geometry: { type: 'Polygon', coordinates: [ring(-0.062, -0.014, 0.042)] } },
          { type: 'Feature', properties: { name: '北侧重点侦察区', color: '#f59e0b' }, geometry: { type: 'Polygon', coordinates: [ring(0.030, 0.055, 0.042)] } },
          { type: 'Feature', properties: { name: '核心搜索区', color: '#22d3ee' }, geometry: { type: 'Polygon', coordinates: [ring(0.000, 0.002, 0.038)] } },
        ]
    const all = s1
      ? feats
      : [
          { type: 'Feature', properties: { name: '当前搜索区域', color: '#3b82f6' }, geometry: { type: 'Polygon', coordinates: [ring(0, 0, 0.105)] } },
          ...feats,
        ]
    return { type: 'FeatureCollection', features: all as GeoJSON.Feature[] }
  }

  static setScenario(s: ScenarioKey) {
    if (this.scenario === s) return
    this.scenario = s
    const src = this.map?.getSource(SRC.area) as maplibregl.GeoJSONSource | undefined
    src?.setData(this.areaData() as never)
  }

  /** 阶段决定哪些图层可见（如 T3 起显示扫描热点、T7 显示轨迹）；与分组开关取交集 */
  static setPhase(p: Phase) {
    this.phase = p
    this.applyVisibility()
  }

  // ---------------------------------------------------------------- 数据
  static setLinks(edges: LinkEdge[], nodes: { id: string; name: string; kind?: string }[]) {
    const c: [number, number] = this.scenario === 'scenario-2' ? [121.4737, 31.2304] : [116.3974, 39.9093]
    const byName = new Map<string, [number, number]>()
    let groupIdx = 0
    nodes.forEach((n) => {
      if (n.kind === 'cloud') byName.set(n.name, [c[0] - 0.010, c[1] + 0.078])
      else if (n.kind === 'edge') byName.set(n.name, [c[0], c[1] + 0.020])
      else if (n.kind === 'forward') byName.set(n.name, [c[0] + 0.004, c[1] - 0.062])
      else {
        const a = (groupIdx++ / 6) * Math.PI * 2 - Math.PI / 2
        byName.set(n.name, [c[0] + 0.056 * Math.cos(a), c[1] + 0.040 * Math.sin(a)])
      }
    })
    const colorOf = (st?: string) => (st === 'yellow' ? '#f59e0b' : st === 'red' ? '#ef4444' : '#22c55e')
    const feats: GeoJSON.Feature[] = []
    edges.forEach((e) => {
      const a = byName.get(e.from_node)
      const b = byName.get(e.to_node)
      if (!a || !b) return
      feats.push({
        type: 'Feature',
        properties: { color: colorOf(e.state), state: e.state, name: `${e.from_node} → ${e.to_node}` },
        geometry: { type: 'LineString', coordinates: [a, b] },
      })
    })
    const src = this.map?.getSource(SRC.link) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: feats } as never)
  }

  static setGroups(groups: Group[]) {
    const c: [number, number] = this.scenario === 'scenario-2' ? [121.4737, 31.2304] : [116.3974, 39.9093]
    const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#22d3ee', '#f97316']
    const feats: GeoJSON.Feature[] = groups.map((g, i) => ({
      type: 'Feature',
      properties: { name: g.name, seq: g.seq, color: palette[i % palette.length] },
      geometry: { type: 'Point', coordinates: [c[0] - 0.070 + (i % 3) * 0.058, c[1] + 0.034 - Math.floor(i / 3) * 0.058] },
    }))
    const src = this.map?.getSource(SRC.group) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: feats } as never)
  }

  static setTargets(targets: Target[], selectedId?: string) {
    const colorOf = (st?: string) => (st === 'red' ? '#ef4444' : st === 'yellow' ? '#f59e0b' : '#8b93a7')
    const feats: GeoJSON.Feature[] = targets.map((t) => ({
      type: 'Feature',
      properties: {
        id: t.id,
        label: `${t.name} · ${t.type}`,
        color: colorOf(t.status),
        selected: t.id === selectedId,
        threat: t.threat,
      },
      geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
    }))
    const src = this.map?.getSource(SRC.target) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: feats } as never)

    // 高威胁目标带扩散脉冲环（红），其余为琥珀
    this.setPulseSeeds(
      targets
        .filter((t) => t.status !== 'gray')
        .map((t) => ({ lng: t.lng, lat: t.lat, color: t.status === 'red' ? '#ef4444' : '#f59e0b' })),
    )
  }

  static setUavs(list: UavPosEvent[]) {
    const colorOf: Record<string, string> = {
      optical: '#22d3ee', radar: '#f59e0b', electronic: '#a855f7', comm: '#22c55e',
    }
    const feats: GeoJSON.Feature[] = list.map((u) => ({
      type: 'Feature',
      properties: { label: u.groupId ?? u.type, color: colorOf[u.type ?? ''] ?? '#22d3ee', battery: u.battery },
      geometry: { type: 'Point', coordinates: [u.lng, u.lat] },
    }))
    const src = this.map?.getSource(SRC.uav) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: feats } as never)

    // 尾迹
    list.forEach((u) => {
      const k = u.uavId
      const arr = trailHistory[k] ?? (trailHistory[k] = [])
      const last = arr[arr.length - 1]
      if (!last || Math.abs(last[0] - u.lng) + Math.abs(last[1] - u.lat) > 0.0002) {
        arr.push([u.lng, u.lat])
        if (arr.length > 40) arr.shift()
      }
    })
    const trailFeats: GeoJSON.Feature[] = Object.entries(trailHistory)
      .filter(([, v]) => v.length > 1)
      .map(([k, v]) => ({
        type: 'Feature',
        properties: { id: k },
        geometry: { type: 'LineString', coordinates: v },
      }))
    const tsrc = this.map?.getSource(SRC.trail) as maplibregl.GeoJSONSource | undefined
    tsrc?.setData({ type: 'FeatureCollection', features: trailFeats } as never)

    // 扫描热点（随机分布，体现覆盖）
    if (this.phase === 'T3') {
      const c: [number, number] = this.scenario === 'scenario-2' ? [121.4737, 31.2304] : [116.3974, 39.9093]
      const hot: GeoJSON.Feature[] = [
        { type: 'Feature', properties: { r: 34, color: '#22d3ee' }, geometry: { type: 'Point', coordinates: [c[0] + 0.020, c[1] + 0.012] } },
        { type: 'Feature', properties: { r: 26, color: '#22c55e' }, geometry: { type: 'Point', coordinates: [c[0] - 0.034, c[1] - 0.020] } },
        { type: 'Feature', properties: { r: 22, color: '#f59e0b' }, geometry: { type: 'Point', coordinates: [c[0] + 0.048, c[1] - 0.034] } },
      ]
      const ssrc = this.map?.getSource(SRC.scan) as maplibregl.GeoJSONSource | undefined
      ssrc?.setData({ type: 'FeatureCollection', features: hot } as never)
    }
  }

  static setTrack(points: TargetTrackPoint[]) {
    if (!points.length) return
    const feats: GeoJSON.Feature[] = [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
    }]
    const src = this.map?.getSource(SRC.track) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: feats } as never)
  }

  /** 视图缩放到某目标 */
  static focus(lng: number, lat: number, zoom = 13) {
    this.map?.easeTo({ center: [lng, lat], zoom, duration: 600 })
  }

  // ---------------------------------------------------------------- 自由图元（绘图 API 驱动）
  /** 直接写入任务区域要素（外部数据驱动；会覆盖内置场景预设区域） */
  static setAreaFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.area) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 直接写入扫描覆盖要素 */
  static setScanFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.scan) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 设置脉冲环种子（公开版；供绘图 API 使用） */
  static setPulseItems(seeds: { lng: number; lat: number; color: string; radiusKm?: number; id?: string }[]) {
    this.setPulseSeeds(seeds.map((s) => ({ lng: s.lng, lat: s.lat, color: s.color, id: s.id })))
  }

  /** 自由标注 / 标记（点 + 文本） */
  static setMarkers(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.mark) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 无人机航线（LineString，属性：color/dashed/name） */
  static setRouteFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.route) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 圈层类图元（LineString 多条，属性：color/weight/dashed/part） */
  static setAnnulusFeatures(fcData: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.annulus) as maplibregl.GeoJSONSource | undefined
    src?.setData(fcData as never)
  }

  /** 圆形/椭圆形区域（Polygon，属性：color/opacity/dashed/weight） */
  static setShapeFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.shape) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  // ---- 坐标显式的自由图元写入（绘图 API 用；与上面的"演示语义"方法解耦） ----
  /** 自由链路（LineString，属性：color/state/name） */
  static setLinkFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.link) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 自由集群点（Point，属性：name/color） */
  static setGroupFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.group) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 自由目标点（Point，属性：id/label/color/selected/threat） */
  static setTargetFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.target) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 自由无人机点（Point，属性：label/color） */
  static setUavFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.uav) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 自由轨迹（多条 LineString，属性：color/dashed） */
  static setTrackFeatures(fc: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.track) as maplibregl.GeoJSONSource | undefined
    src?.setData(fc as never)
  }

  /** 自由的脉冲环种子（绘图 API 用） */
  static setPulseSeedsPublic(seeds: { lng: number; lat: number; color: string; id?: string }[]) {
    this.setPulseSeeds(seeds)
  }

  /** 清空全部动态图层（不影响底图） */
  static clearAll() {
    for (const id of Object.values(SRC)) {
      const src = this.map?.getSource(id) as maplibregl.GeoJSONSource | undefined
      src?.setData({ type: 'FeatureCollection', features: [] } as never)
    }
    this.pulseSeeds = []
    deleteTrailHistory()
  }

  // ---------------------------------------------------------------- 图层顺序与透明度（M2-CTRL-12）

  /**
   * 把它组图层移动到参照组之前（`before`）或之后（`after`）。
   * 用于宿主调整叠放次序，例如让"任务区域"压在"目标"下面。
   *
   * 实现说明：MapLibre 的 `moveLayer(id, beforeId)` 要求 beforeId 是**目标位置的下一个**图层；
   * 这里按组处理——先把该组的全部图层从样式中移出再按顺序插入，保证组内相对次序不变。
   */
  static moveGroup(group: LayerGroup, target: LayerGroup, position: 'before' | 'after' = 'before'): boolean {
    const map = this.map
    if (!map || group === target) return false
    const ids = GROUP_LAYERS[group].filter((id) => map.getLayer(id))
    if (!ids.length) return false

    const anchorIds = GROUP_LAYERS[target].filter((id) => map.getLayer(id))
    if (!anchorIds.length) return false

    // 先全部摘下（moveLayer 到自身之前相当于原地不动，所以改用"逐个移到锚点前"）
    for (const id of ids) {
      if (position === 'before') {
        map.moveLayer(id, anchorIds[0])
      } else {
        // 移到锚点组最后一个图层之后 → 用"移到锚点下一层之前"，没有下一层就直接移到栈顶
        const anchorLast = anchorIds[anchorIds.length - 1]
        const order = map.getStyle().layers.map((l) => l.id)
        const nextIdx = order.indexOf(anchorLast) + 1
        const nextId = order[nextIdx]
        if (nextId) map.moveLayer(id, nextId)
        else map.moveLayer(id)
      }
    }
    return true
  }

  /** 当前图层从下到上的顺序（只列模块自己的图层，供宿主/调试查看） */
  static layerOrder(): string[] {
    const map = this.map
    if (!map) return []
    const own = new Set(Object.values(LYR))
    return map.getStyle().layers.map((l) => l.id).filter((id) => own.has(id))
  }

  /** 读取某分组的整体透明度（未设置过时返回 1） */
  static groupOpacity(group: LayerGroup): number {
    return this.opacity.get(group) ?? 1
  }

  /**
   * 设置某分组的整体透明度（0–1）。
   * 做法：把该组各图层的 `*-opacity` 乘上该系数——因此**保留**图元自身的透明度语义
   * （例如区域填充本来就 0.1，乘 0.5 后是 0.05），而不是覆盖成固定值。
   */
  static setGroupOpacity(group: LayerGroup, opacity: number) {
    const map = this.map
    const o = Math.max(0, Math.min(1, opacity))
    this.opacity.set(group, o)
    if (!map) return

    for (const id of GROUP_LAYERS[group]) {
      if (!map.getLayer(id)) continue
      const layer = map.getStyle().layers.find((l) => l.id === id) as Record<string, unknown> | undefined
      const base = this.baseOpacity.get(id) ?? this.readBaseOpacity(id)
      this.baseOpacity.set(id, base)
      for (const prop of ['fill-opacity', 'line-opacity', 'circle-opacity', 'circle-stroke-opacity', 'icon-opacity', 'text-opacity']) {
        // 只对"图层真的声明了该透明度属性"的情况设置，避免给不支持的图层瞎设属性
        if (layer && (layer.paint as Record<string, unknown> | undefined)?.[prop] !== undefined) {
          try { map.setPaintProperty(id, prop, base * o) } catch { /* 该图层不支持此属性，忽略 */ }
        }
      }
    }
  }

  /** 读取图层当前的（首个透明度属性的）数值，作为"基准透明度"记住 */
  private static readBaseOpacity(id: string): number {
    const map = this.map
    if (!map) return 1
    for (const prop of ['fill-opacity', 'line-opacity', 'circle-opacity', 'circle-stroke-opacity', 'text-opacity']) {
      try {
        const v = map.getPaintProperty(id, prop as never)
        if (typeof v === 'number') return v
        if (Array.isArray(v)) return 1   // 表达式形式（如按要素取值）→ 基准记 1，不再二次换算
      } catch { /* 不支持则跳过 */ }
    }
    return 1
  }
}

/** 清空航迹历史（clearAll 用） */
function deleteTrailHistory() {
  for (const k of Object.keys(trailHistory)) delete trailHistory[k]
}
