// mission-app · map-2d · src/primitives/draw-api.ts
//
// **几何原语绘制 API** —— 用户第 2 条：
//   "绘画的功能，可以画最基础的点，线，面，点可配置大小演示，线可配置粗细演示，
//    面由闭合线来代替，也需要真正的面，也需要能绘制椭圆，圆形这类图元，
//    **绘制的功能都为可调用的函数接口，不是配置文件 —— 配置文件不管这些**。"
//
// 于是这一层只做一件事：把"我要在这儿画个点/线/面/圆/椭圆"翻译成模块已有的图元种类，
// **所有外观都从函数入参来**（大小 / 粗细 / 颜色 / 虚实 / 填充…），不看任何样式配置文件。
//
// 与既有 `MapDraw.set/add(kind, item)` 的关系：
//   · `MapDraw` 是**按图元种类**的底层接口（target / scan / pulse / symbol … 业务化的种类）
//   · `draw.*` 是**按几何**的上层接口（point / line / closedLine / polygon / circle / ellipse）
//   两者并存：`draw.*` 内部就是调 `MapDraw`，不引入第二套渲染。业务化种类仍然可用。
//
// 13 种图元 → 6 个几何原语的映射（逐个照抄字段名，不编字段）：
//   point      → label（`radius` 画点，`text` 留空）
//   line       → route（`widthPx` / `dashed` / `color`）
//   closedLine → route（把首点补到末尾，**不填充**）
//   polygon    → area （`polygon` 填充 + 边界；`weight` 线宽、`dashed` 虚实）
//   circle     → shape（`radiusKm`，`kind:'plain'`）
//   ellipse    → shape（`radiusKm` + `radiusKmMinor` + `rotation`）
import { MapDraw, type ShapeItem } from './api'
import type { PrimitiveKind } from './api'
// 2026-09-21：草稿提交（"确认后才绘制"）——本文件是**唯一**知道怎么把草稿画成图元的地方，
// 通过 `registerDraftCommitter` 注册给 core/draft.ts（单向依赖，避免绕成 import 环）
import { registerDraftCommitter, type GeometryDraft } from '../core/draft'
import { distanceMeters, type LngLat } from '../core/geometry'
import * as geom from '../core/geometry'   // 顶点读写的字段映射（verticesOf / withVertices）

/** 所有几何原语共有的字段 */
export interface DrawCommon {
  /** 图元 id；不给就自动生成（`geo:<seq>`），返回值始终是最终 id */
  id?: string
  /** 是否显示（默认 true） */
  visible?: boolean
  /** 主色（点/线/描边） */
  color?: string
  /**
   * **跟随文本**（用户第 3 条要的"文本框绑定"的入口）。
   *
   * 传了它就等于"这个图元要带一段说明"，由模块的文本层负责定位与跟随 —— 调用方
   * 不需要自己再画一条 `label`、也不需要自己算锚点。样式走 `textStyle`。
   */
  text?: string
  /** 文本框样式（见 `TextStyle`）；不给用 `'tag'` */
  textStyle?: TextStyle
  /**
   * **标签锚点走哪条规则**（2026-09-21 新增；**可选，不给 = 与改造前一致**）。
   *
   * 需求（原话）："**规划航线的标签，放到航线中间，而非末尾**" —— 而且**只改航线**。
   *   · 不传 / `'topRight'`：标签挂在图元"最右上"那个点外侧（**默认口径**，面 / 圆 / 点 / 其它线都用它）；
   *   · `'mid'`：标签挂在**折线中点**（按累计长度取一半处）外侧 —— 宿主画"规划航线"时传这个。
   *
   * 为什么要做成**图元自带的提示**而不是模块里按名字认：识别"哪条是规划航线"是**业务知识**，
   * 属于宿主；模块只提供"这条线想把标签放中间"这个通用能力（换名字/换语言都不受影响）。
   */
  textAnchor?: 'topRight' | 'mid'
  /**
   * **标签锚点从图元往外延多少屏幕像素**（可选；不给 = 模块默认 `ANCHOR_OUT_PX`）。
   * 例：规划航线用 9（比默认的 6 再往外一点），见 `text-layer.ts` 的 `anchorOf`。
   */
  anchorOutPx?: number
}

/** 文本框的几种样式（用户第 3 条："可以绑定几种文本框的方式"） */
export type TextStyle =
  /** 一行小角标：底色 + 细边，贴着图元，最省地方 */
  | 'tag'
  /** 卡片：标题 + 多行正文，适合"名称 + 参数"这种信息量 */
  | 'card'
  /** 引线标注：一根引线指向图元，文字浮在旁边，不压住图形 */
  | 'callout'

export interface PointSpec extends DrawCommon {
  lng: number
  lat: number
  /** **点的大小**（半径，像素）。用户第 2 条："点可配置大小演示" */
  sizePx?: number
}

export interface LineSpec extends DrawCommon {
  points: [number, number][]
  /** **线的粗细**（像素）。用户第 2 条："线可配置粗细演示" */
  widthPx?: number
  dashed?: boolean
}

export interface PolygonSpec extends DrawCommon {
  /** 环（首尾不必闭合；模块自己会闭合） */
  ring: [number, number][]
  /** 填充色；不给则不填充（只画边界） */
  fillColor?: string
  /** 填充不透明度（0~1，默认 0.1） */
  fillOpacity?: number
  /** 边界线宽（px，默认 1.4） */
  strokeWidthPx?: number
  dashed?: boolean
}

export interface CircleSpec extends DrawCommon {
  lng: number
  lat: number
  radiusKm: number
  fillColor?: string
  fillOpacity?: number
  strokeWidthPx?: number
  dashed?: boolean
}

export interface EllipseSpec extends CircleSpec {
  /** 短半轴（公里）—— 圆的"压扁版"，必须有它才是椭圆 */
  radiusKmMinor: number
  /** 旋转角（度，正北 0、顺时针），默认 0 */
  rotation?: number
}

// ---------------------------------------------------------------- 内部工具

let seq = 0
const autoId = () => `geo:${++seq}`

/** 把 `text`/`textStyle` 收成"要挂的跟随文本"（没有就不挂） */
function textOf(spec: DrawCommon): { text: string; style: TextStyle } | null {
  const t = spec.text?.trim()
  return t ? { text: t, style: spec.textStyle ?? 'tag' } : null
}

/**
 * **图元种类 → 原生文字写在哪个字段上**（★ 2026-09-18 新增）。
 *
 * 文字现在由模块的**原生 symbol 图层**画（`LayerManager` 里的 `textLayerOf`：
 * `lyr-area-label` / `lyr-route-label` / `lyr-shape-label` / `lyr-mark-label` / `lyr-uav-label` …），
 * 那些图层各自从要素的某个字段取字。所以"给图元配一段文字"这件事，本质是**把字写进那个字段**：
 *
 *   · 点类（`label`）/ 标注（`mark`）→ `text`
 *   · 面（`area`）/ 圈层（`shape`）/ 航线（`route`）/ 目标 / 无人机 → `label`
 *   · 集群 / 群组 → `name`
 *
 * 没有对应图层的种类（`track` / `annulus` / `pulse`）不在此表里 —— 它们只登记绑定关系、
 * 不画文字，行为与改造前一致。
 */
export const NATIVE_TEXT_FIELD: Partial<Record<PrimitiveKind, string>> = {
  label: 'text', drone: 'label', target: 'label', cluster: 'name',
  scan: 'label', link: 'name', symbol: 'label', area: 'label',
  shape: 'label', route: 'label',
}

/**
 * 把 `text` 收成"要写进图元字段的原生文字"（没有文字就返回空对象，即不改动图元）。
 * 写进去之后由渲染器直接画在地图上 —— **不再需要 HTML 浮层**。
 */
function nativeTextOf(kind: PrimitiveKind, spec: DrawCommon): Record<string, unknown> {
  const t = textOf(spec)
  const field = NATIVE_TEXT_FIELD[kind]
  if (!t || !field) return {}
  return { [field]: t.text, textStyle: t.style }
}

/**
 * 把"要挂的跟随文本"登记给文本层（`textBindings`），返回登记 id。
 *
 * 这里是**绑定关系**的唯一入口：文本框记的是 `{ ownerKind, ownerId }`，
 * 图元被删/被隐藏时文本层能跟着联动（见 `TextOverlay`）。
 */
export interface TextBinding {
  id: string
  ownerKind: PrimitiveKind
  ownerId: string
  text: string
  style: TextStyle
}
const textBindings = new Map<string, TextBinding>()

function bindText(ownerKind: PrimitiveKind, ownerId: string, spec: DrawCommon): void {
  const t = textOf(spec)
  const id = `${ownerId}:text`
  if (!t) { textBindings.delete(id); return }
  textBindings.set(id, { id, ownerKind, ownerId, text: t.text, style: t.style })
}

/**
 * **图元自带的"标签怎么放"提示**（2026-09-21 新增；两个字段都可选）。
 *
 * 会写进图元字段，供 `text-layer` 的 `anchorOf` 读取 —— 与 `textStyle` 同一套路：
 * "这条线的标签想放中间""往外多延几像素"属于**这个图元的显示属性**，
 * 写在图元上就跟着它一起被导出 / 存档 / 复制，不需要第二份登记表。
 */
function anchorHintsOf(spec: DrawCommon): Record<string, unknown> {
  return {
    ...(spec.textAnchor ? { textAnchor: spec.textAnchor } : {}),
    ...(spec.anchorOutPx !== undefined ? { anchorOutPx: spec.anchorOutPx } : {}),
  }
}

/** 图元被删时把它的文本一起删（联动，避免"图没了字还在"） */
function dropText(ownerId: string): void {
  textBindings.delete(`${ownerId}:text`)
}

// ---------------------------------------------------------------- 几何原语

/**
 * 画**点**。大小走 `sizePx`（半径像素），颜色走 `color`，需要说明就给 `text`。
 * @returns 图元 id
 */
function point(spec: PointSpec): string {
  const id = spec.id ?? autoId()
  MapDraw.add('label', {
    id, lng: spec.lng, lat: spec.lat,
    // 文字直接进 `text` 字段（`lyr-mark-label` 原生画）——不再走 HTML 浮层
    text: spec.text?.trim() ?? '',
    ...(spec.textStyle ? { textStyle: spec.textStyle } : {}),
    color: spec.color, radius: spec.sizePx ?? 4,
    visible: spec.visible,
  })
  bindText('label', id, spec)
  return id
}

/** 画**线**（折线，可配粗细/虚实）。至少 2 个点，否则不画并返回 null */
function line(spec: LineSpec): string | null {
  if (spec.points.length < 2) return null
  const id = spec.id ?? autoId()
  MapDraw.add('route', {
    id, points: spec.points,
    color: spec.color, dashed: spec.dashed ?? false,
    widthPx: spec.widthPx, visible: spec.visible,
    // 航线名称进 `label` 字段（`lyr-route-label` 原生画；`name` 是"不渲染"的数据字段）
    ...nativeTextOf('route', spec),
    // 标签怎么放（可选提示；规划航线用 `textAnchor: 'mid'` + `anchorOutPx: 9`）
    ...anchorHintsOf(spec),
  })
  bindText('route', id, spec)
  return id
}

/**
 * 画**闭合线**（用户第 2 条："面由闭合线来代替"）—— 首尾自动接上，**不填充**。
 * 适合"只要一个圈、不要色块"的场合（例如任务区边界）。
 */
function closedLine(spec: LineSpec): string | null {
  if (spec.points.length < 3) return null
  const first = spec.points[0]
  const last = spec.points[spec.points.length - 1]
  const closed = first[0] === last[0] && first[1] === last[1] ? spec.points : [...spec.points, first]
  return line({ ...spec, points: closed })
}

/** 画**真正的面**（填充 + 边界）。环少于 3 点不画并返回 null */
function polygon(spec: PolygonSpec): string | null {
  if (spec.ring.length < 3) return null
  const id = spec.id ?? autoId()
  MapDraw.add('area', {
    id, polygon: spec.ring,
    // 不传 fillColor 就**不填充**（opacity 0），只留边界 —— 这样"真面"和"闭合线"可以按需二选一
    color: spec.fillColor ?? spec.color,
    opacity: spec.fillColor ? (spec.fillOpacity ?? 0.1) : 0,
    dashed: spec.dashed ?? false,
    weight: spec.strokeWidthPx,
    visible: spec.visible,
    // 区域名称进 `label` 字段（`lyr-area-label` 原生画）
    ...nativeTextOf('area', spec),
  })
  bindText('area', id, spec)
  return id
}

/** 画**圆** */
function circle(spec: CircleSpec): string {
  const id = spec.id ?? autoId()
  MapDraw.add('shape', { ...shapeOf(spec, id, 'plain'), ...nativeTextOf('shape', spec) })
  bindText('shape', id, spec)
  return id
}

/** 画**椭圆**（长半轴 `radiusKm`、短半轴 `radiusKmMinor`、可选旋转角） */
function ellipse(spec: EllipseSpec): string {
  const id = spec.id ?? autoId()
  MapDraw.add('shape', { ...shapeOf(spec, id, 'plain'), ...nativeTextOf('shape', spec) })
  bindText('shape', id, spec)
  return id
}

function shapeOf(spec: CircleSpec, id: string, kind: ShapeItem['kind']): ShapeItem {
  const e = spec as EllipseSpec
  return {
    id, lng: spec.lng, lat: spec.lat,
    radiusKm: spec.radiusKm,
    ...(e.radiusKmMinor ? { radiusKmMinor: e.radiusKmMinor } : {}),
    ...(e.rotation ? { rotation: e.rotation } : {}),
    kind,
    color: spec.fillColor ?? spec.color,
    opacity: spec.fillColor ? (spec.fillOpacity ?? 0.1) : 0,
    weight: spec.strokeWidthPx ?? 1.2,
    dashed: spec.dashed ?? false,
    visible: spec.visible,
  }
}

// ---------------------------------------------------------------- 删除 / 查询

/** 按 id 删一个几何原语（**连同它的跟随文本一起删**） */
function remove(id: string): boolean {
  for (const kind of ['label', 'route', 'area', 'shape'] as PrimitiveKind[]) {
    if (MapDraw.list(kind).some((x) => (x as { id: string }).id === id)) {
      MapDraw.remove(kind, id)
      dropText(id)
      return true
    }
  }
  return false
}

/**
 * **改一个图元上绑定的文本内容**（宿主做"点文本可改"用）。
 *
 * 绑定关系在模块里，所以改文本也该走模块 —— 宿主不需要知道文本框是怎么画的。
 * @returns 该图元**原本就有**绑定文本才返回 true；没有绑定则不动（要新增请用 `bindTextTo`）
 */
export function setBoundText(ownerId: string, text: string): boolean {
  const b = textBindings.get(`${ownerId}:text`)
  if (!b) return false
  textBindings.set(b.id, { ...b, text })
  // ★ 文字由原生 symbol 图层画，改字必须落到图元字段上（否则只有登记表变了、画面不动）
  const field = NATIVE_TEXT_FIELD[b.ownerKind]
  if (field) MapDraw.patch(b.ownerKind, ownerId, { [field]: text })
  return true
}

/** **给一个已存在的图元补一条绑定文本**（先建图元、后配文字时用） */
export function bindTextTo(ownerKind: PrimitiveKind, ownerId: string, text: string, style: TextStyle = 'tag'): boolean {
  const exists = MapDraw.list(ownerKind).some((x) => (x as { id: string }).id === ownerId)
  if (!exists) return false
  textBindings.set(`${ownerId}:text`, { id: `${ownerId}:text`, ownerKind, ownerId, text, style })
  // 同上：把字写进图元字段，原生图层才会画（无对应字段的种类只登记、不画，行为同改造前）
  const field = NATIVE_TEXT_FIELD[ownerKind]
  if (field) MapDraw.patch(ownerKind, ownerId, { [field]: text, textStyle: style })
  return true
}

/** **改一个图元上文本框的样式**（角标 / 卡片 / 引线标注）—— 用户在界面上切换用 */
export function setBoundStyle(ownerId: string, style: TextStyle): boolean {
  const b = textBindings.get(`${ownerId}:text`)
  if (!b) return false
  textBindings.set(b.id, { ...b, style })
  const field = NATIVE_TEXT_FIELD[b.ownerKind]
  if (field) MapDraw.patch(b.ownerKind, ownerId, { textStyle: style })
  return true
}

/** 读一个图元绑定的文本框样式（没绑定返回 null） */
export function boundStyleOf(ownerId: string): TextStyle | null {
  return textBindings.get(`${ownerId}:text`)?.style ?? null
}

/** 读一个图元绑定的文本（没有绑定返回 null） */
export function boundTextOf(ownerId: string): string | null {
  return textBindings.get(`${ownerId}:text`)?.text ?? null
}

/** 读取"绑在图元上的跟随文本"（文本层用；外部一般不用） */
export function textBindingsOf(): TextBinding[] {
  return [...textBindings.values()]
}

/** 列出全部几何原语 id（按几何分组；显隐管理面板可以用它） */
export function listGeometry(): Record<string, string[]> {
  return {
    point: MapDraw.list('label').map((x) => (x as { id: string }).id),
    line: MapDraw.list('route').map((x) => (x as { id: string }).id),
    polygon: MapDraw.list('area').map((x) => (x as { id: string }).id),
    circle: MapDraw.list('shape').map((x) => (x as { id: string }).id),
  }
}

// ---------------------------------------------------------------- 编辑态：顶点读 / 写（2026-09-21）
//
// 为什么加这一段：需求"编辑态点击选中图元后也弹出合并框（可改坐标）"—— 宿主拿到了 id，
// 但**它不该知道**这个 id 落在哪一类图元、顶点存在 `points` 还是 `polygon` 字段里（那是模块的事）。
// 所以这里给两个极小的接口：按 id 读顶点、按 id 写顶点；字段映射复用 `geom.verticesOf/withVertices`。

/** 顶点可自由增删的图元种类（折线 / 区域；点类只有 1 个顶点，删了就没了） */
export function isVertexListKind(kind: PrimitiveKind): boolean {
  return kind === 'route' || kind === 'area' || kind === 'track'
}

/** 按 id 找到图元：返回它落在哪一类 + 那条记录（找不到返回 null） */
export function findGeometry(id: string): { kind: PrimitiveKind; item: Record<string, unknown> } | null {
  const kinds: PrimitiveKind[] = ['label', 'route', 'area', 'shape']
  for (const k of kinds) {
    const item = (MapDraw.list(k) as unknown as Record<string, unknown>[]).find((x) => x.id === id)
    if (item) return { kind: k, item }
  }
  return null
}

/** 按 id 读顶点（编辑态的合并框要显示它们；找不到图元返回空数组） */
export function verticesOfId(id: string): LngLat[] {
  const hit = findGeometry(id)
  return hit ? geom.verticesOf(hit.kind, hit.item) : []
}

/**
 * **把一个图元整体旋转**（2026-09-21 需求："选中状态后，支持按键 `r` 旋转区域"）。
 *
 * 为什么放在模块里而不是宿主：主机的"旋转"对模块来说就是"顶点整体转一下再写回"，
 * 而**顶点存在哪、要不要闭合、哪几类图元能转**都是模块的知识（宿主不猜字段）。
 *
 * 口径（需求方定点）：
 *   · **逆时针**（地图上逆时针：东 → 北）；
 *   · 每次 **15°**（角度由宿主给，模块不写死）；
 *   · **绕图元外接框的中心**转（比"顶点平均"稳：线/面顶点疏密不均时平均点会偏）；
 *   · 只对**有顶点列表**的图元生效（面 / 折线）；点类与圈层类没有顶点可转 → 返回 false。
 *   · 面若存成**闭合环**（末尾重复首点，`draw.polygon` 就是这么落的），旋转时**不影响**：
 *     首尾仍保持重合（同一个点转完还是同一个点）。
 *
 * @returns 是否真的转动（false = 没这个图元 / 顶点少于 2 个）
 */
export function rotateGeometry(id: string, degrees: number): boolean {
  const hit = findGeometry(id)
  if (!hit) return false
  const pts = geom.verticesOf(hit.kind, hit.item)
  if (pts.length < 2) return false                       // 点类（1 个顶点）没有"转"的语义
  // 外接框中心（用经纬度各自的极值中点，不用顶点平均）
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const a = (degrees * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  // 注意方向：地图上"东"是 lng+（x），"北"是 lat+（y）。要**逆时针**，用 (x,y) → (x·cos − y·sin, x·sin + y·cos)。
  const out = pts.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as LngLat
  })
  return setVerticesOfId(id, out)
}

/**
 * 按 id 写顶点（编辑态改坐标 / 加行 / 删行都走它）。
 * @returns 是否写成功；失败（id 不存在）返回 false，**不改任何东西**
 */
export function setVerticesOfId(id: string, pts: LngLat[]): boolean {
  const hit = findGeometry(id)
  if (!hit) return false
  if (!pts.length) return false                       // 不允许把顶点清空（点类删到 0 就没意义了）
  if (!isVertexListKind(hit.kind) && pts.length !== 1) return false  // 点类只能 1 个顶点
  MapDraw.add(hit.kind, geom.withVertices(hit.kind, hit.item, pts) as never)
  return true
}

/**
 * **几何原语绘制入口** —— 只有函数，不吃配置文件。
 *
 * @example
 * draw.point({ lng: 116.527, lat: 39.80, sizePx: 6, color: '#22d3ee', text: '观察点' })
 * draw.line({ points: [[116.527, 39.70], [116.527, 39.86]], widthPx: 3, text: '航线' })
 * draw.closedLine({ points: taskRing, widthPx: 2, color: '#ef4444', text: '任务区' })
 * draw.polygon({ ring: taskRing, fillColor: '#ef4444', fillOpacity: 0.12, strokeWidthPx: 2, text: '任务区' })
 * draw.circle({ lng: 116.527, lat: 39.80, radiusKm: 2, text: '威胁区' })
 * draw.ellipse({ lng: 116.527, lat: 39.80, radiusKm: 4, radiusKmMinor: 2, rotation: 0, text: '威胁区' })
 */
export const draw = {
  point,
  line,
  closedLine,
  polygon,
  circle,
  ellipse,
  remove,
  list: listGeometry,
}

/**
 * **把草稿提交成图元**（2026-09-21 新增；由 `core/draft.ts` 的 `commit()` 调用）。
 *
 * 这一段就是"点击确认后绘制"里**真正落图的那一下**：之前收笔只产生草稿（图上只有预览），
 * 宿主在合并框里改完标签 / 经纬度、点了确定，才走到这里。
 *
 * 两条路：
 *   · 草稿带 `make`（业务层自定义：军标 / 距离环 / 目标点…）→ 交给 `make` 造，**文字由它自己挂**
 *     （与改造前的行为一致：`biz-catalog.ts` 的 `makeKind` 里 `bindTextTo(..., label)`）；
 *   · 否则按几何种类画原语，并把标签当 `text` 一起传下去（模块原语自带绑定文本的能力）。
 */
function commitDraft(d: GeometryDraft): string | null {
  const pts = d.points.map((p) => [p[0], p[1]] as LngLat)
  if (d.make) {
    const radiusKm = pts.length >= 2 ? distanceMeters(pts[0], pts[1]) / 1000 : 0
    return d.make(pts.map((p) => ({ lng: p[0], lat: p[1] })), radiusKm)
  }
  const text = d.label || undefined
  switch (d.kind) {
    case 'point':
      if (!pts.length) return null
      return point({ lng: pts[0][0], lat: pts[0][1], sizePx: d.sizePx, color: d.color, text, textStyle: d.textStyle }) as string
    case 'line':
      if (pts.length < 2) return null
      return line({ points: pts, widthPx: d.widthPx, color: d.color, dashed: d.dashed, text, textStyle: d.textStyle }) as string
    case 'closedLine':
      if (pts.length < 3) return null
      return closedLine({ points: pts, widthPx: d.widthPx, color: d.color, dashed: d.dashed, text, textStyle: d.textStyle }) as string
    case 'polygon':
      if (pts.length < 3) return null
      return polygon({
        ring: pts, fillColor: d.fillColor, fillOpacity: d.fillOpacity,
        strokeWidthPx: d.widthPx, dashed: d.dashed, text, textStyle: d.textStyle,
      }) as string
    // 圆 / 椭圆本轮不走草稿（`DRAFT_KEYS` 里没有它们）；真要用时给两个顶点即可
    case 'circle':
      if (pts.length < 2) return null
      return circle({
        lng: pts[0][0], lat: pts[0][1],
        radiusKm: Math.max(0.05, distanceMeters(pts[0], pts[1]) / 1000),
        color: d.color, fillColor: d.fillColor, fillOpacity: d.fillOpacity,
        strokeWidthPx: d.widthPx, dashed: d.dashed, text, textStyle: d.textStyle,
      }) as string
    case 'ellipse':
      if (pts.length < 2) return null
      return ellipse({
        lng: pts[0][0], lat: pts[0][1],
        radiusKm: Math.max(0.05, distanceMeters(pts[0], pts[1]) / 1000),
        radiusKmMinor: Math.max(0.05, distanceMeters(pts[0], pts[1]) / 2000),
        color: d.color, fillColor: d.fillColor, fillOpacity: d.fillOpacity,
        strokeWidthPx: d.widthPx, dashed: d.dashed, text, textStyle: d.textStyle,
      }) as string
    default:
      return null
  }
}

// 注册给 `core/draft.ts`（单向依赖：那边不 import 本文件，避免与 interaction 绕成环）
registerDraftCommitter({ draw: commitDraft })
