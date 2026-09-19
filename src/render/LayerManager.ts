// LayerManager.ts —— MapLibre 原生动态图层管理（地图模块内部实现）
//
// 图层：区域多边形 / 链路 / 集群 / 目标 / 无人机 / 扫描热点 / 轨迹
// 增量原则：source.setData() 而非重建图层（TRD 性能设计要点）。
// 分组显隐：setGroupVisible()，满足 MAP-04「多图层可独立开关」。
import type { Map as MlMap } from 'maplibre-gl'
import { MAP_OPTIONS } from '../core/options'
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
  symbol: 'src-symbol',
  /**
   * ★ 2026-09-18 新增：**统一文字源**（点要素）。
   *
   * 为什么不再用"各图元源自带的 symbol 图层"：那种做法下文字的锚点是 MapLibre 自己推的
   * （面取几何内部点、线取中点），模块**插不上手**，而需求方要的是
   * 「航路的标识放到航路旁边；其他图元放到**整个图元**的右上角（不是中心点的右上角）」——
   * 锚点必须由模块自己算。于是统一成：模块把每条文字算成一个**点要素**放这个源里，
   * 文字与底块都以这个点为准（见 `src/primitives/text-layer.ts`）。
   */
  text: 'src-text',
  /** ★ 2026-09-18 新增：文字**底块**（方案 C —— 底块是模块自己画的面，不用 sprite） */
  textBox: 'src-text-box',
  /** ★ 2026-09-18 新增：**选中高亮**源（图元选中/删除用，见 core/selection.ts） */
  selection: 'src-selection',
}

const LYR = {
  areaFill: 'lyr-area-fill',
  areaLine: 'lyr-area-line',
  // ★ 2026-09-18 新增：区域面的**虚线**边界单独一层。
  //   原来 `lyr-area-line` 把 `line-dasharray: [4,3]` 写死了 → **区域面永远画不出实线**
  //   （用户："排查，区域是否能绘制实线" —— 改之前不能）。
  //   MapLibre 的 `line-dasharray` 不支持数据表达式，所以照模块既有做法（route / shape / annulus）
  //   拆成"实线层 + 虚线层"，用 `filter` 按要素属性 `dashed` 分流。
  areaLineDashed: 'lyr-area-line-dashed',
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
  /** 位图图标层（本批新增，可选能力）：只在启用位图且图片加载成功时才有要素命中 */
  uavIcon: 'lyr-uav-icon',
  scan: 'lyr-scan',
  track: 'lyr-track',
  /** 虚线轨迹层（本批新增）：`line-dasharray` 不支持数据表达式，只能用 filter 分流 */
  trackDashed: 'lyr-track-dashed',
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
  symbol: 'lyr-symbol',
  symbolLabel: 'lyr-symbol-label',
  /**
   * ★ 2026-09-18 新增：**统一文字层**（配合 `SRC.text`）。
   *   一条图层吃三种文本框样式 —— 字号 / 颜色 / 描边 / 偏移 / 锚点全部**逐要素数据驱动**。
   */
  /**
   * ★ 2026-09-18 新增：**统一文字层**（配合 `SRC.text`）—— 一种文本框样式一条图层。
   *   `text` 这条 id 保留给"默认那条"（tag），另两条按样式区分；见 `textLayers()` 的说明。
   */
  text: 'lyr-text',
  textTag: 'lyr-text-tag',
  textCard: 'lyr-text-card',
  textCallout: 'lyr-text-callout',
  /**
   * ★ 2026-09-18 新增：文字**底块**（方案 C）。
   *   需求方 2026-09-18 决定：底块不用 sprite + `icon-text-fit`（那条路下框按文字"行盒"算，
   *   比字形大一圈、字还贴在框角上，观感差且调不动），改成**模块自己画的面**：
   *   尺寸、圆角、透明度全是模块的数据，和文字**同一个锚点、同一套像素尺寸**，天然对齐。
   */
  textBoxFill: 'lyr-text-box-fill',
  textBoxLine: 'lyr-text-box-line',
  /**
   * ★ 2026-09-18 新增：**选中高亮**（两层：线 + 点圆环）。
   *   不进任何图层分组 —— 它跟着"选中态"走，不该被图层开关或一键全隐影响。
   */
  selLine: 'lyr-sel-line',
  selCircle: 'lyr-sel-circle',
  /** 已退役的旧文字层 id（保留常量是为了不破坏别处引用；`init` 里已不再创建它们） */
  areaLabel: 'lyr-area-label',
  routeLabel: 'lyr-route-label',
  shapeLabel: 'lyr-shape-label',
}

const emptyFC = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] })

/**
 * 可独立开关的图层分组（对外公开，供图层开关面板使用）。
 *
 * ★ 2026-09-18 新增 `'text'`（标签）：需求方"图元显示隐藏功能，**添加标签显示隐藏**"。
 *   文字现在是一条统一图层 + 两个底块图层（见 `LYR.text` / `textBoxFill` / `textBoxLine`），
 *   单独成组才能和图元一样被一键开关。
 */
export type LayerGroup = 'area' | 'pulse' | 'scan' | 'link' | 'group' | 'track' | 'trail' | 'target' | 'uav' | 'mark' | 'route' | 'annulus' | 'symbol' | 'text'

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
  symbol: '标绘符号',
  text: '标签（文字与底块）',
}

const GROUP_LAYERS: Record<LayerGroup, string[]> = {
  area: [LYR.areaFill, LYR.areaLine, LYR.areaLineDashed, LYR.areaLabel],
  pulse: [LYR.pulse],
  scan: [LYR.scan],
  link: [LYR.linkGlow, LYR.link],
  group: [LYR.group, LYR.groupLabel],
  track: [LYR.track, LYR.trackDashed],
  trail: [LYR.trail],
  target: [LYR.targetGlow, LYR.target, LYR.targetLabel],
  uav: [LYR.uavGlow, LYR.uavIcon, LYR.uav, LYR.uavLabel],
  mark: [LYR.mark, LYR.markLabel],
  route: [LYR.routeGlow, LYR.route, LYR.routeDashed, LYR.shapeFill, LYR.shapeLine, LYR.shapeLineDashed, LYR.routeLabel, LYR.shapeLabel],
  annulus: [LYR.annulus, LYR.annulusDashed],
  symbol: [LYR.symbol, LYR.symbolLabel],
  // ★ 标签：统一文字层 + 底块两层（关掉它 = 图上所有文字与底块一起消失）
  text: [LYR.text, LYR.textBoxFill, LYR.textBoxLine],
}

export const ALL_LAYER_GROUPS = Object.keys(GROUP_LAYERS) as LayerGroup[]

/**
 * **统一文字层**（★ 2026-09-18，方案 C；三次改造后定为"**单层 + 全常量**"）。
 *
 * 需求方两条放置规则（位置由 `src/primitives/text-layer.ts` 算好，写进要素坐标）：
 *   · **航路的标识放到航路旁边**（不压在线身上）；
 *   · **其他图元放到"整个图元"的右上角** —— 不是"中心点的右上角"，而是**外接框的右上角**。
 *
 * ⚠️ 血泪教训（这一天在这上面栽了三次，写清楚免得再犯）：
 *   1. 把字号/颜色/描边/锚点/偏移做成**逐要素数据驱动**（style-spec 说它们支持）→
 *      **整层文字几乎不可见**（框在、字没了），控制台只留一句
 *      `Expected value to be of size array<number, 2>, but found string instead`。
 *   2. 改成"一种样式一条图层 + 过滤器" → **仍然看不见**（过滤器把要素全滤掉了）。
 *   3. 最后**逐项替换成常量**做二分：把 paint/layout 全换成常量后字立刻**清晰可见** ✓
 *      —— 这一步既证明了**字形没问题**，也定位到问题出在数据驱动那几项上。
 *   所以现在这条图层：**除了 `text-field`，全是常量**，连 `textStyle` 都不参与（不分样式）。
 *   要恢复"角标/卡片/引线"三种样式，请**先在小页面上单独验证**再加回来。
 *
 * ⚠️ `text-font` 必须显式给成本工程的字形栈（`MAP_OPTIONS.textFont`）：
 *    MapLibre 缺省栈 `["Open Sans Regular","Arial Unicode MS Regular"]` 在 `glyphsUrl` 下取不到 PBF，
 *    **整层文字都会消失**。
 */
function textLayer(): never {
  return {
    id: LYR.text, type: 'symbol', source: SRC.text,
    layout: {
      'text-field': ['coalesce', ['get', 'text'], ''],
      'text-font': MAP_OPTIONS.textFont,
      // 位置由模块算好（锚点即目标地理位置），渲染器只做"字心对准锚点"
      'text-anchor': 'center',
      'text-offset': [0, 0],
      // 需求方 2026-09-18：字号 24。
      // ★ 24 不只是"更大"：字形 PBF 是按 **24px em** 生成的（`gen-glyphs.cs` 的 EM=24），
      //   所以 24px 显示是 **1:1**，SDF 的过渡带正好落在 1 个屏幕像素上 —— 这是最清晰的一档；
      //   16px 时是 0.67 倍缩，过渡带摊到 1.5px 以上，观感就是"糊"。
      'text-size': 24,
      // 不折行：缺省 `text-max-width` 是 10em，「出航通道（1000 m）」这种稍长的名字会被切成两行
      'text-max-width': 40,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-padding': 0,
    },
    paint: {
      // 需求方：**白色文字、取消描边**（这一版先看无描边的观感）。
      //   底块由模块自己画（方案 C），背景已经压深，白字直接压上去即可。
      //   要恢复黑边：把 `text-halo-width` 给 0.6~1.5（超过 1.5 会开始吃笔画，
      //   24px 汉字笔画只有 3~4px，给 4 会糊成一坨 —— 之前试过）。
      'text-color': '#ffffff',
      'text-halo-color': '#000000',
      'text-halo-width': 0,
    },
  } as never
}

/**
 * 文字**底块**（★ 2026-09-18 方案 C）：两层 = 填充 + 描边，几何由模块算（`SRC.textBox`）。
 *
 * 为什么不用 sprite + `icon-text-fit`（原先的做法）：那条路下框是按文字**行盒**算的，
 * 行盒含行距与降部空间（CJK 没有降部 → 纯空白），于是框比字形大一圈、字还贴在框角上，
 * 观感差且**调不动**（padding 只在框内加空隙，改不了框与字的相对位置）。
 * 现在框和字**共用同一个锚点与同一套像素尺寸**（模块测字宽），天然对齐。
 */
function textBoxLayers(): never[] {
  return [
    {
      id: LYR.textBoxFill, type: 'fill', source: SRC.textBox,
      paint: {
        'fill-color': ['coalesce', ['get', 'color'], '#0a1d33'],
        'fill-opacity': ['coalesce', ['get', 'opacity'], 0.68],
      },
    },
    {
      id: LYR.textBoxLine, type: 'line', source: SRC.textBox,
      // 细亮边：在深色影像上勾出框的轮廓，同时保持"轻"
      paint: { 'line-color': 'rgba(140,190,235,.40)', 'line-width': 1 },
    },
  ] as never[]
}

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
  /**
   * 图层分组开关变化时的回调（★ 2026-09-18）。
   * 统一文字层用它重算：某个分组被关掉时，那类图元的**文字与底块要一起不画**
   * （文字层是所有种类共用的一条，没法靠图层可见性自动跟随，只能在数据侧过滤）。
   */
  private static visibilityHook: (() => void) | null = null

  /** 注册上面的回调（`src/primitives/text-layer.ts` 启动时调一次） */
  static registerVisibilityHook(fn: () => void) {
    this.visibilityHook = fn
  }

  /** setPhase 挂出的"样式重建后重放可见性"回调（触发即摘除，见 setPhase） */
  private static phaseRebindOff: (() => void) | null = null

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
    // 分组开关变了 → 通知文字层重算（文字与底块都要跟着分组的显隐走）
    this.visibilityHook?.()
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
    // 与阶段无关的图层（任务区域、标注、航线/图形区、**标签**）始终按分组开关显示
    on.push(...GROUP_LAYERS.area, ...GROUP_LAYERS.mark, ...GROUP_LAYERS.route, ...GROUP_LAYERS.annulus, ...GROUP_LAYERS.symbol, ...GROUP_LAYERS.text)
    if (recon) on.push(LYR.scan)
    if (recon || p === 'T7') on.push(LYR.trail)
    // 无人机位置：侦察阶段起显示（T3–T7）。
    // 修正：此前该组从未被阶段规则打开，导致 setUavs 灌入的实时位置不显示
    //（与《技术需求文档》MAP-02「集群动态图层」的要求不符）。
    // 注意：新增的位图图标层与圆点层**同属 uav 组**，必须一起进这个集合——否则会出现
    // "分组开关点得动但画面没反应"（该图层被阶段规则关着）这种自相矛盾的状态。
    if (recon || p === 'T7') on.push(LYR.uav, LYR.uavGlow, LYR.uavIcon, LYR.uavLabel)
    // 轨迹：轨迹是"目标轨迹回放"语义，模块既有规则只在 scenario-2 的侦察阶段显示。
    // 新增的虚线轨迹层与实线层同属 track 组，必须一起进集合（理由同上）。
    if (recon && this.scenario === 'scenario-2') on.push(LYR.track, LYR.trackDashed)
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
    // ★ 2026-09-18（用户："我需要的是 map2d 只做绘画与显示"）：**区域源不再预置任何几何**。
    //   原先这里是 `add(SRC.area, this.areaData())` —— 模块自带一批"业务场景假数据"
    //   （北京 116.3974,39.9093 / 上海 121.4737,31.2304 的 A/B/C 区），宿主不覆盖就会画出来。
    //   现在与其它源一致：**空数据源**，谁用谁 `MapDraw.set('area', …)` 塞。
    add(SRC.area, emptyFC())
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
    add(SRC.symbol, emptyFC())
    // ★ 2026-09-18 新增：统一文字源 + 文字底块源 + 选中高亮源（分别由 text-layer.ts / selection.ts 填）
    add(SRC.text, emptyFC())
    add(SRC.textBox, emptyFC())
    add(SRC.selection, emptyFC())

    // ---- 区域多边形（任务分区） ----
    map.addLayer({
      id: LYR.areaFill, type: 'fill', source: SRC.area,
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.10 },
    })
    map.addLayer({
      id: LYR.areaLine, type: 'line', source: SRC.area,
      // 实线边界：要素没标 `dashed:true` 的都走这一条（默认实线）
      filter: ['!=', ['get', 'dashed'], true],
      paint: { 'line-color': ['get', 'color'], 'line-width': ['coalesce', ['get', 'weight'], 1.4], 'line-opacity': 0.9 },
    })
    map.addLayer({
      id: LYR.areaLineDashed, type: 'line', source: SRC.area,
      // 虚线边界：要素标了 `dashed: true` 的走这一条
      filter: ['==', ['get', 'dashed'], true],
      paint: { 'line-color': ['get', 'color'], 'line-width': ['coalesce', ['get', 'weight'], 1.4], 'line-dasharray': [4, 3], 'line-opacity': 0.8 },
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
        // ★ 2026-09-18 退役：文字统一由 LYR.text 画（锚点由模块算，见 text-layer.ts）
        'text-field': ['literal', ''],
        'text-font': MAP_OPTIONS.textFont,
        'text-size': 11.5,
        'text-offset': [0, 1.9],
        'text-anchor': 'top',
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#cfe6ff', 'text-halo-color': 'rgba(5,10,20,.9)', 'text-halo-width': 2.2 },
    })

    // ---- 轨迹回溯 ----
    // 本批新增：线宽 / 透明度改为数据驱动（属性 `width` / `lineOpacity`），
    // 由绘图 API 按「图元字段 > 样式配置 > 内置缺省」解析后写入。
    // 实/虚仍用 filter 分流：MapLibre 的 line-dasharray **不支持数据表达式**。
    // 属性 `dash` 用数字（1 = 虚线、0 = 实线）：MapLibre 的 `==` 过滤器对布尔属性
    // 要求字面量类型完全一致（写 true 会因 "boolean" vs "number" 报样式错），数字最稳。
    map.addLayer({
      id: LYR.track, type: 'line', source: SRC.track,
      filter: ['!=', ['get', 'dash'], 1],
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#ef4444'],
        'line-width': ['coalesce', ['get', 'width'], 2],
        'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.9],
      },
    })
    map.addLayer({
      id: LYR.trackDashed, type: 'line', source: SRC.track,
      filter: ['==', ['get', 'dash'], 1],
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#ef4444'],
        'line-width': ['coalesce', ['get', 'width'], 2],
        'line-opacity': ['coalesce', ['get', 'lineOpacity'], 0.9],
        'line-dasharray': [3, 2],
      },
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
        // ★ 2026-09-18 退役：文字统一由 LYR.text 画
        'text-field': ['literal', ''],
        'text-font': MAP_OPTIONS.textFont,
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
    // 本批新增（可选能力）：半径 / 填充 / 描边改为数据驱动，属性由绘图 API 按
    // 「图元字段 > 样式配置 > 内置缺省」写进要素；缺省值就是改造前的取值
    // （半径 5、描边 #e8f1ff、描边宽 1），因此不配样式时画面不变。
    // 只画"没有位图可用"的那些（`hasIcon` 为真时由下面的图标层负责）。
    map.addLayer({
      id: LYR.uav, type: 'circle', source: SRC.uav,
      filter: ['!=', ['get', 'hasIcon'], true],
      paint: {
        'circle-radius': ['coalesce', ['get', 'radius'], 5],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['coalesce', ['get', 'strokeColor'], '#e8f1ff'],
        'circle-stroke-width': ['coalesce', ['get', 'strokeWidth'], 1],
      },
    })
    // 位图图标层：同一数据源，只画命中 `hasIcon` 的要素。
    // 图片由 core/markerIcon.ts 用 `map.addImage` 注册；**加载失败时该要素不会
    // 带上 hasIcon**，于是自动由上面的圆点层画出来 —— 这就是"降级为点"的落点。
    map.addLayer({
      id: LYR.uavIcon, type: 'symbol', source: SRC.uav,
      filter: ['==', ['get', 'hasIcon'], true],
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['coalesce', ['get', 'iconSize'], 1],
        'icon-anchor': ['coalesce', ['get', 'iconAnchor'], 'center'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
    map.addLayer({
      id: LYR.uavLabel, type: 'symbol', source: SRC.uav,
      layout: {
        // ★ 2026-09-18 退役：文字统一由 LYR.text 画
        'text-field': ['literal', ''],
        'text-size': 10.5,
        // 不折行（同 textLayerOf）：无人机标签是「机型 + 编号」两段，缺省会从空格处断成两行
        'text-max-width': 30,
        // ★ 放机身**右上角**（同 textLayerOf：文字左下角贴锚点 → 整体落在右上方）
        'text-offset': [0.5, -0.5],
        'text-anchor': 'bottom-left',
        'text-allow-overlap': false,      // 避让：重叠的标签由渲染器自动隐藏（M2-DRAW-11）
        'text-ignore-placement': false,
        // ★ 底色块：见 textLayerOf 里的说明（无人机标签默认走 tag 样式那张图）
        'icon-image': ['match', ['get', 'textStyle'], 'card', 'textbox-card', 'callout', 'textbox-callout', 'textbox-tag'],
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [0, 3, 0, 3],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-padding': 0,
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
        // ★ 2026-09-18 退役：文字统一由 LYR.text 画
        'text-field': ['literal', ''],
        'text-size': ['coalesce', ['get', 'size'], 11],
        // 不折行（同 textLayerOf）
        'text-max-width': 30,
        // ★ 放图元**右上角**（同 textLayerOf）
        'text-offset': [0.5, -0.5],
        'text-anchor': 'bottom-left',
        'text-allow-overlap': false,      // 避让：重叠的标签由渲染器自动隐藏（M2-DRAW-11）
        'text-ignore-placement': false,
        // ★ 底色块：见 textLayerOf 里的说明
        'icon-image': ['match', ['get', 'textStyle'], 'card', 'textbox-card', 'callout', 'textbox-callout', 'textbox-tag'],
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [0, 3, 0, 3],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-padding': 0,
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
        // ★ 2026-09-18：线宽可逐个图元给（几何原语 draw.line({widthPx}) 用）；不给就是原来的 1.6
        'line-width': ['coalesce', ['get', 'widthPx'], 1.6],
        'line-opacity': 0.95,
      },
    })
    map.addLayer({
      id: LYR.routeDashed, type: 'line', source: SRC.route,
      filter: ['==', ['get', 'dashed'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#22d3ee'],
        // ★ 2026-09-18：线宽可逐个图元给（几何原语 draw.line({widthPx}) 用）；不给就是原来的 1.6
        'line-width': ['coalesce', ['get', 'widthPx'], 1.6],
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

    // ---- 国军标标绘符号（需求 M2-DRAW-16）----
    map.addLayer({
      id: LYR.symbol, type: 'symbol', source: SRC.symbol,
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-size': ['coalesce', ['get', 'size'], 1],
        'icon-rotate': ['coalesce', ['get', 'rotation'], 0],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    })
    map.addLayer({
      id: LYR.symbolLabel, type: 'symbol', source: SRC.symbol,
      layout: {
        // ★ 2026-09-18 退役：文字统一由 LYR.text 画
        'text-field': ['literal', ''],
        'text-font': MAP_OPTIONS.textFont,
        'text-size': 10.5,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-ignore-placement': false,
      },
      paint: { 'text-color': '#cfe3f5', 'text-halo-color': 'rgba(5,10,20,.85)', 'text-halo-width': 1.6 },
    })

    // ---- 文字底块 + 统一文字层（★ 2026-09-18，方案 C）----
    // 顺序要紧：底块先加 → 落在文字**下面**；两者都加在最后 → 落在所有几何**上面**。
    for (const l of textBoxLayers()) map.addLayer(l)
    map.addLayer(textLayer())
    // ★ 选中高亮（线 + 点圆环）：加在最后 → 压在所有图元之上；不进任何分组，只跟着选中态走
    map.addLayer({
      id: LYR.selLine, type: 'line', source: SRC.selection,
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: {
        'line-color': '#ffd400', 'line-width': 2.5, 'line-opacity': 0.95,
        'line-dasharray': [2, 1.4],
      },
    } as never)
    map.addLayer({
      id: LYR.selCircle, type: 'circle', source: SRC.selection,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 11, 'circle-color': 'rgba(255,212,0,0)',
        'circle-stroke-color': '#ffd400', 'circle-stroke-width': 2.5,
      },
    } as never)

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

  // ---------------------------------------------------------------- 场景

  static setScenario(s: ScenarioKey) {
    if (this.scenario === s) return
    this.scenario = s
    // ★ 2026-09-18：原先这里会 `src.setData(this.areaData())`，即**每次切场景都往区域源里灌一批
    //   模块自带的业务假数据**。模块只做绘画与显示 —— 换场景不该凭空多出几个"分区"。
    //   现在只**清空**区域源（要画什么由宿主 `MapDraw.set('area', …)` 决定）。
    const src = this.map?.getSource(SRC.area) as maplibregl.GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features: [] } as never)
  }

  /** 阶段决定哪些图层可见（如 T3 起显示扫描热点、T7 显示轨迹）；与分组开关取交集 */
  static setPhase(p: Phase) {
    this.phase = p
    this.applyVisibility()
    // 阶段是模块级状态，而"换底图"会重建样式（图层对象全新，新图层的默认可见性
    // 不受此前 setPhase 影响）。这里给下一次样式重建挂**一次性**回调，把当前阶段
    // 再应用一遍；回调触发即摘除，不会长期驻留（`styledata` 在瓦片更新时也会发）。
    const map = this.map
    if (!map || this.phaseRebindOff) return
    const off = () => {
      this.phaseRebindOff = null
      map.off('styledata', onStyledata)
    }
    const onStyledata = () => {
      off()
      this.applyVisibility()
    }
    this.phaseRebindOff = off
    map.on('styledata', onStyledata)
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
    // 注意：这里刻意**不写 hasIcon**——`['!=', ['get','hasIcon'], true]` 对"属性不存在"
    // 求值为真，因此圆点层照旧画；图标层不会命中。这条"业务数据直灌"入口的行为
    // 与改造前一致（位图能力只在绘图 API 那条路上生效，见 primitives/api.ts）。
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
      // dash:1 —— 这条"业务数据直灌"入口改造前就是虚线（lyr-track 的 line-dasharray [3,2]），
      // 分流到新的虚线层后保持原样。
      properties: { dash: 1 },
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

  /** 国军标标绘符号（Point + icon，属性：icon/size/rotation/label） */
  static setSymbolFeatures(fcData: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.symbol) as maplibregl.GeoJSONSource | undefined
    // icon 字段由 symbols.ts 计算后写进属性；这里只负责落源
    src?.setData(fcData as never)
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

  /**
   * 统一文字源（★ 2026-09-18 新增）。
   * 点要素，属性：`text` / `size` / `color` / `halo` / `anchor` / `offset` —— 位置由
   * `src/primitives/text-layer.ts` 按"航路旁边 / 图元整体右上角"算好。
   */
  static setTextFeatures(fcData: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.text) as maplibregl.GeoJSONSource | undefined
    src?.setData(fcData as never)
  }

  /** 文字底块源（★ 2026-09-18 新增，方案 C）：模块自己画的面，属性：`color` / `opacity` */
  static setTextBoxFeatures(fcData: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.textBox) as maplibregl.GeoJSONSource | undefined
    src?.setData(fcData as never)
  }

  /**
   * **选中高亮**源（★ 2026-09-18 新增）：只放"当前选中那个图元"的高亮几何
   * （线/折线 → LineString；点 → Point 画圆环），空数组 = 没有选中。
   */
  static setSelectionFeatures(fcData: GeoJSON.FeatureCollection) {
    const src = this.map?.getSource(SRC.selection) as maplibregl.GeoJSONSource | undefined
    src?.setData(fcData as never)
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

  /** 底图栅格图层 id（主题调亮度/饱和度用） */
  static baseLayerIds(): string[] {
    const map = this.map
    if (!map) return []
    return map.getStyle().layers
      .filter((l) => l.type === 'raster' && String(l.id).startsWith('base'))
      .map((l) => l.id)
  }

  /** 底图着色叠加层 id */
  static tintLayerIds(): string[] {
    const map = this.map
    if (!map) return []
    return map.getStyle().layers
      .filter((l) => l.type === 'fill' && (l.id === 'base-tint' || String(l.id).includes('tint')))
      .map((l) => l.id)
  }

  /** 带文字标注的图层 id（主题调标签可读性用） */
  static labelLayerIds(): string[] {
    return [LYR.markLabel, LYR.targetLabel, LYR.groupLabel, LYR.uavLabel].filter((id) => !!this.map?.getLayer(id))
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
