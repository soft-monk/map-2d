// map-2d · 统一文字与底块（★ 2026-09-18，需求方方案 C）
//
// 需求方原话：
//   · 「文本框，本意就是为了标识图元的」
//   · 「只要航路的标识是放到航路旁边」
//   · 「其他图元，修改为放到右上角，不是中心点右上角，而是**图元整体的右上角**」
//
// 为什么不让 MapLibre 自己算锚点：`symbol` 图层对"面"取几何内部点、对"线"取中点，
// 模块**插不上手**。所以这里改成：**模块把每条文字算成一个点要素**（`SRC.text`），
// 文字与底块都以此点为准 ——
//   · 文字：`text-anchor: 'center'` + 偏移 0（渲染器语义最确定的一档）
//   · 底块：模块按**同一锚点 + 同一套像素尺寸**画一个圆角矩形面（`SRC.textBox`）
//
// 底块为什么不用 sprite + `icon-text-fit`：那条路下框按文字**行盒**算（含行距/降部空白），
// 比字形大一圈、字还贴在框角上，观感差且调不动 —— 需求方看过之后否掉了（改走方案 C）。
//
// ⚠️ 这个文件必须用编辑工具改，**不要过 PowerShell 的 Get-Content/Set-Content**：
//    无 BOM 的 .ts 会被按 ANSI 读，中文注释会变成乱码、且**换行会被吃掉**
//    （被吃掉换行的那一行会把后面的代码一起注释掉）。本项目已经因此损坏过两次。
import { MapDraw, type PrimitiveKind } from './api'
import { NATIVE_TEXT_FIELD } from './draw-api'
import { LayerManager, type LayerGroup } from '../render/LayerManager'
import { mapInstance } from '../core/instance'

/**
 * 三种文本框样式的字号（px）—— 必须与 `LayerManager.textLayer()` 的 `text-size` 常量一致。
 * 取 **24**：字形 PBF 是按 24px em 生成的，24px 显示是 **1:1**，SDF 过渡带正好落在
 * 一个屏幕像素上 —— 最清晰的一档（16px 是 0.67 倍缩，观感就"糊"）。
 */
const STYLE_SIZE = { tag: 24, card: 24, callout: 24 } as const
type StyleKey = keyof typeof STYLE_SIZE

/** 底块内边距（px）—— 需求方要"贴合"，所以给得很小 */
const PAD_X = 3
const PAD_Y = 1.5
/** 底块与图元之间的间隙（px） */
const GAP = 5
/**
 * **锚点从图元上"往外延展"多少像素**（2026-09-21 需求方："往外延展一点点距离"）。
 * 方向 = 图元"最左下 → 最右上"（见 `extendOutward`）。改这一个数即可调"一点点"到底多大。
 */
const ANCHOR_OUT_PX = 6
/**
 * 文字锚点的补偿系数（单位：字号）。
 * 实测：`text-anchor: 'center'` 下渲染器把**字心**放在锚点上方约 1em（24px 下量过），
 * 补 1.05em 后字心落在框心（上下余量各约 2px = PAD_Y 量级）。
 */
const INK_LIFT = 1.15
/** 底块圆角（px） */
const RADIUS = 3
/**
 * **CJK 字侧边距补偿（px）**。
 * 汉字的"墨迹"比"笔进"窄，而且偏左（末字的右边距不进墨）——实测 24px 下「威胁区」
 * 框 80 / 墨迹 70，右侧余量 8px、左侧只有 2px（CSS 文本框也有同样现象）。
 * 把框整体收窄这么多并右移一半，两侧余量就匀了（实测收到 左 4 / 右 4）。
 */
const CJK_BEARING = 5

/** 参与"统一文字"的图元种类（没有文字图层的种类不参与，保持改造前的行为） */
const TEXT_KINDS: PrimitiveKind[] = ['area', 'route', 'shape', 'label', 'drone', 'target', 'cluster', 'symbol']

/** 种类 → 图层分组（分组被关掉时，它的文字与底块一起不画） */
const GROUP_OF: Partial<Record<PrimitiveKind, LayerGroup>> = {
  area: 'area', route: 'route', shape: 'route', label: 'mark',
  drone: 'uav', target: 'target', cluster: 'group', symbol: 'symbol',
}

// ---------------------------------------------------------------- 量文字尺寸

let measureCtx: CanvasRenderingContext2D | null = null

/**
 * 量文字尺寸（px）：返回**笔进宽度**与**墨迹高度**。
 *
 * · 宽度用 `m.width`（笔进宽度）：渲染器就是把它居中到锚点的，按它做框天然左右对称。
 *   试过改用"墨迹宽度"（`actualBoundingBoxLeft + Right`），反而引入偏心（实测左 2 / 右 8），已回退。
 * · 高度用 `actualBoundingBoxAscent + Descent`（**墨迹高度**）：行高（1.2em）含行距与降部空白，
 *   会把框上下各撑出一大截，永远"贴不住"。拿不到该 API 时退回 1.05em。
 */
function measureText(text: string, size: number): { boxW0: number; inkH: number; dx: number } {
  if (!measureCtx && typeof document !== 'undefined') {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (measureCtx) {
    // 字体族取本机常见项：与 gen-glyphs.cs 生成 PBF 时用的字体同源，量出来才准
    measureCtx.font = `${size}px "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`
    const m = measureCtx.measureText(text)
    const bl = m.actualBoundingBoxLeft
    const br = m.actualBoundingBoxRight
    const asc = m.actualBoundingBoxAscent
    const desc = m.actualBoundingBoxDescent
    const hasBox = typeof bl === 'number' && typeof br === 'number'
      && typeof asc === 'number' && typeof desc === 'number'
    if (m.width > 0) {
      // 宽度取**墨迹宽**（`bl + br`），不是笔进宽 `m.width`：CJK 的笔进含两侧边距，
      // 按笔进做框右边会多出 5~8px（实测「威胁区」：框 80 / 字 70，右余量 8）。
      const inkW = hasBox && bl + br > 0 ? bl + br : m.width
      const inkH = hasBox && asc + desc > 0 ? Math.min(asc + desc, size * 1.3) : size * 1.05
      // 渲染器是把**笔进框**居中到锚点的，所以按墨迹做框要整体平移：墨迹中心 − 笔进中心
      const dx = hasBox ? (br - bl) / 2 - m.width / 2 : 0
      return { boxW0: inkW, inkH, dx }
    }
  }
  // 兜底估算：表意文字按 1em、其余按 0.55em；高度按 1.05em
  let w = 0
  for (const ch of text) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? size : size * 0.55
  return { boxW0: w, inkH: size * 1.05, dx: 0 }
}

/**
 * 每像素多少米（赤道值）。
 *
 * ⚠️ 用 **40075016.686 / 512**，不是常见的 `156543.03392`（那个是"256px 瓦片"的写法）。
 *    MapLibre 的世界尺寸是 `worldSize = 512 · 2^zoom`（实测 zoom=11 时 worldSize = 1048576），
 *    所以 256 那套常数算出来的"每像素米数"**大一倍** —— 底块会正好宽一倍、高一倍
 *    （这次踩到：字 35px、框算成 87px，比例恰好 2）。
 */
const MPP_EQUATOR_512 = 40075016.686 / 512

/** 像素 → 经纬度增量（按锚点纬度做墨卡托换算） */
function pxToDeg(px: number, lat: number, zoom: number) {
  const mpp = (MPP_EQUATOR_512 / Math.pow(2, zoom)) * Math.cos((lat * Math.PI) / 180)
  return {
    dLat: (px * mpp) / 110540,
    dLng: (px * mpp) / (111320 * Math.cos((lat * Math.PI) / 180) || 1e-6),
  }
}

// ---------------------------------------------------------------- 锚点：按需求方的两条规则

interface Anchor { lng: number; lat: number }

/**
 * **图元上"最右上角"的那个顶点**（2026-09-21 需求方口径）。
 *
 * 需求原话："按图元上的最右上角的点来算，往外延展一点点距离" —— 也就是**不再用外接框右上角**
 * （那个角可能压根不在图形上），而是取图元**自己的顶点**里最靠右上的那一个。
 *
 * 判据：**经度 + 纬度之和最大**（需求方定稿）。矩形上它恰好就是右上角那个顶点；
 * 任意不规则多边形也总能选出唯一的一个"最右上"顶点。
 */
function topRightVertex(pts: [number, number][]): Anchor | null {
  if (!pts.length) return null
  let best = pts[0]
  let bestSum = best[0] + best[1]
  for (const p of pts) {
    const s = p[0] + p[1]
    if (s > bestSum) { best = p; bestSum = s }
  }
  return { lng: best[0], lat: best[1] }
}

/**
 * **把锚点从图形上"往外延展"一点点**（2026-09-21 需求方："往外延展一点点距离"，起点 6 px）。
 *
 * 方向 = **"最左下" → "最右上"**（需求方定稿的"从图元中心指向那个点的方向"；用这两个极值点求方向，
 * 比外接框中心更贴形状，且**单点图元也成立** —— 点类就是"点 → 点"的退化情形，锚点即点本身，
 * 与"标签挂在点的右上"这条既有行为一致）。
 * 距离按**屏幕像素**算，复用本文件已有的 `pxToDeg`（不引第二套换算口径）。
 */
function extendOutward(anchor: Anchor, pts: [number, number][], lat: number, zoom: number, px = ANCHOR_OUT_PX): Anchor {
  if (!pts.length) return anchor
  let maxSum = -Infinity, minSum = Infinity
  let trLng = anchor.lng, trLat = anchor.lat, blLng = anchor.lng, blLat = anchor.lat
  for (const [lng, la] of pts) {
    const s = lng + la
    if (s > maxSum) { maxSum = s; trLng = lng; trLat = la }
    if (s < minSum) { minSum = s; blLng = lng; blLat = la }
  }
  const vx = trLng - blLng
  const vy = trLat - blLat
  const len = Math.hypot(vx, vy)
  if (len < 1e-12) return anchor                       // 退化（单点）→ 方向无意义，锚点即该点
  const { dLat, dLng } = pxToDeg(px, lat, zoom)
  // 归一化后各轴分别按"1 px 对应多少度"缩放 —— 与标签框的偏移用同一套换算
  return {
    lng: anchor.lng + (vx / len) * dLng,
    lat: anchor.lat + (vy / len) * dLat,
  }
}

/**
 * **折线中点**（按累计长度取一半处的点）—— 2026-09-21 需求方要"规划航线的标签放到航线中间"。
 * 实现与上一轮删掉的那版 `lineMidpoint()` 同口径（按分段长度累加），只是现在由
 * `item.textAnchor === 'mid'` 显式点名才用（**默认仍是"最右上顶点"**，别的线不受影响）。
 */
function lineMidpoint(pts: [number, number][]): Anchor | null {
  if (pts.length < 2) return null
  const seg: number[] = []
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    seg.push(d)
    total += d
  }
  if (total === 0) return { lng: pts[0][0], lat: pts[0][1] }
  let acc = 0
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= total / 2) {
      const t = (total / 2 - acc) / (seg[i] || 1)
      return {
        lng: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        lat: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
      }
    }
    acc += seg[i]
  }
  return { lng: pts[pts.length - 1][0], lat: pts[pts.length - 1][1] }
}

/**
 * **圆 / 椭圆的"最右上那个点"**（2026-09-21 需求方口径）。
 *
 * 圆上没有顶点，取**既不超出圆周、又最靠右上**的那一点 —— 也就是**右上 45° 方位**在圆/椭圆上的点。
 * 换算**照抄渲染器**（`primitives/api.ts` 的 `ellipseRing`）：同一套 `R = 6371.0088` 与方位角旋转，
 * 保证"锚点落在画出来的那个椭圆上"，不会因为两套常数而偏出去。
 */
function ellipseTopRight(item: Record<string, unknown>): Anchor | null {
  const lng = item.lng as number | undefined
  const lat = item.lat as number | undefined
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  const R = 6371.0088                                   // km（与渲染器一致）
  const rad = (d: number) => (d * Math.PI) / 180
  const deg = (r: number) => (r * 180) / Math.PI
  const a = (item.radiusKm as number) ?? 0              // 长半轴（km）
  const b = ((item.radiusKmMinor as number) ?? a)       // 短半轴（km）
  const rot = rad((item.rotation as number) ?? 0)       // 长轴方位角（正北 0、顺时针）
  const cosLat = Math.max(1e-6, Math.cos(rad(lat)))
  // 右上 45° 的参数点（局部平面坐标：东 x、北 y）
  const x = a * Math.cos(Math.PI / 4)
  const y = b * Math.sin(Math.PI / 4)
  const east = x * Math.cos(rot) + y * Math.sin(rot)
  const north = -x * Math.sin(rot) + y * Math.cos(rot)
  return { lng: lng + deg(east / (R * cosLat)), lat: lat + deg(north / R) }
}

/**
 * 锚点规则（**2026-09-21 改版；同日再补一条"规划航线走中点"**）：
 *   · **面（area）**：取**多边形顶点里"最右上"的那一个**，再往外延 `outPx`
 *   · **圆/椭圆（shape）**：取**右上 45° 在圆上的点**（它没有顶点）
 *   · **航线（route）**：**默认**取折线顶点里"最右上"的那一个；
 *     若该图元显式声明了 `textAnchor: 'mid'`（宿主画规划航线时传的），则取**折线中点** ——
 *     需求方："**规划航线的标签，放到航线中间，而非末尾**"，且**只改航线**。
 *   · **点类（label/drone/target/cluster/symbol）**：就是点本身，再往外延
 *
 * 外延像素：默认 `ANCHOR_OUT_PX`（6），图元可用 `anchorOutPx` 覆盖（规划航线用 9）。
 * `zoom` 只用于外延那一步（像素换算）。
 */
function anchorOf(kind: PrimitiveKind, item: Record<string, unknown>, zoom: number): Anchor | null {
  // 图元自带的两个显示提示（都是可选；不传 = 与改造前完全一致）
  const outPx = typeof item.anchorOutPx === 'number' ? item.anchorOutPx : ANCHOR_OUT_PX
  if (kind === 'area') {
    const pts = ((item.polygon as [number, number][]) ?? []).slice()
    const tr = topRightVertex(pts)
    return tr ? extendOutward(tr, pts, tr.lat, zoom, outPx) : null
  }
  if (kind === 'shape') {
    const tr = ellipseTopRight(item)
    if (!tr) return null
    // 椭圆：锚点已在圆周上的"最右上点"（`ellipseTopRight` 直接算的就是它）→ 无需再延展
    return tr
  }
  if (kind === 'route') {
    const pts = ((item.points as [number, number][]) ?? []).slice()
    if (item.textAnchor === 'mid') {
      const mid = lineMidpoint(pts)
      if (!mid) return null
      // 外延方向：拿**首段两端点**当"最左下 → 最右上"的参照（与其它图元同一套外延逻辑），
      // 于是标签落在中点外侧，**不压在线身正中**。
      const seg = pts.length >= 2 ? [pts[0], pts[1]] : pts
      return extendOutward(mid, seg, mid.lat, zoom, outPx)
    }
    const tr = topRightVertex(pts)
    return tr ? extendOutward(tr, pts, tr.lat, zoom, outPx) : null
  }
  const lng = item.lng as number | undefined
  const lat = item.lat as number | undefined
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  // 点类：点自己就是"最右上顶点"，`pts` 只含它一个 → 延展方向退化，锚点即点本身（与改造前一致）
  return extendOutward({ lng, lat }, [[lng, lat]], lat, zoom, outPx)
}

// ---------------------------------------------------------------- 底块形状（圆角矩形）

/** 圆角用"切角"近似：每个角用两个点代替，视觉上足够圆 */
function roundedRect(minLng: number, minLat: number, maxLng: number, maxLat: number, rLng: number, rLat: number): [number, number][] {
  const x1 = minLng, y1 = minLat, x2 = maxLng, y2 = maxLat
  const rx = Math.min(rLng, (x2 - x1) / 2)
  const ry = Math.min(rLat, (y2 - y1) / 2)
  return [
    [x1 + rx, y1], [x2 - rx, y1], [x2, y1 + ry], [x2, y2 - ry],
    [x2 - rx, y2], [x1 + rx, y2], [x1, y2 - ry], [x1, y1 + ry], [x1 + rx, y1],
  ]
}

// ---------------------------------------------------------------- 同步

function labelOf(kind: PrimitiveKind, item: Record<string, unknown>): string {
  const field = NATIVE_TEXT_FIELD[kind] ?? 'label'
  const raw = item[field]
  let text = typeof raw === 'string' ? raw.trim() : ''
  // 与改造前各图层一致的两处兜底：目标/聚合气泡没给名字就退回 id
  if (!text && (kind === 'target' || kind === 'cluster')) text = String(item.id ?? '')
  return text
}

let raf = 0
let boundMap: unknown = null

/** 重算全部文字与底块，并落到两个数据源上 */
export function syncText(): void {
  const map = mapInstance.current
  if (!map) return
  const zoom = map.getZoom()

  const textFeats: GeoJSON.Feature[] = []
  const boxFeats: GeoJSON.Feature[] = []

  for (const kind of TEXT_KINDS) {
    const group = GROUP_OF[kind]
    if (group && !LayerManager.isGroupVisible(group)) continue
    for (const raw of MapDraw.list(kind) as unknown as Record<string, unknown>[]) {
      if (raw.visible === false) continue
      const text = labelOf(kind, raw)
      if (!text) continue
      // `zoom` 只用于"锚点往外延展几像素"这一步（2026-09-21）
      const anchor = anchorOf(kind, raw, zoom)
      if (!anchor) continue

      const style = (typeof raw.textStyle === 'string' ? raw.textStyle : 'tag') as StyleKey
      const size = STYLE_SIZE[style] ?? STYLE_SIZE.tag
      // 框 = **墨迹**宽 + 2·PAD_X × **墨迹**高 + 2·PAD_Y —— 需求方要"框贴合字"；
      // 再扣掉 CJK 字侧边距（见 CJK_BEARING），两侧余量才匀。
      const { boxW0, inkH, dx } = measureText(text, size)
      const boxW = boxW0 - CJK_BEARING + PAD_X * 2
      const boxH = inkH + PAD_Y * 2

      // ★ 关键取巧：**不靠 `text-offset` 去挪字**，而是把"右上角"做进**锚点的地理位置**里。
      //   文字用 `text-anchor: 'center'`、偏移 0 → 字心就在锚点上；
      //   底块是同一个锚点、同一套像素尺寸的矩形 → 框与字同心。
      //   锚点 = 图元锚点（面/圈层是外接框右上角、航路是中点）再往右上让出"半个框 + 间隙"，
      //   于是框的左下角正好落在图元锚点右上 GAP 处。
      const { dLat, dLng } = pxToDeg(1, anchor.lat, zoom)
      const cx = anchor.lng + (GAP + boxW / 2) * dLng
      const cy = anchor.lat + (GAP + boxH / 2) * dLat
      // ⚠️ 实测补偿：`text-anchor: 'center'` 下**渲染器把字心放在锚点上方约 1em**
      //    （红点打在锚点上、红点在框心，字却在框顶之上；字形度量本身是对的）。
      //    这里只挪**文字要素**，不挪底块，让字心落回框心。
      const cyText = cy - INK_LIFT * size * dLat
      textFeats.push({
        type: 'Feature',
        properties: {
          // 数据只喂这两样：文字 + 样式。字号/颜色/描边/锚点/偏移都是**图层常量** ——
          // 逐要素喂那些属性会让整层文字看不见（见 LayerManager.textLayer() 的说明）。
          text, textStyle: style, size,
        },
        geometry: { type: 'Point', coordinates: [cx, cyText] },
      })

      // 底块：与**墨迹**同心（方案 C：模块自己画的面）。
      //   横向要补 `dx`：渲染器居中"笔进框"，墨迹中心因此偏离锚点 —— 不补就是左 2 / 右 8。
      //   墨迹在笔进框里偏**左**（末字右边距不进墨），所以框要往左挪半个补偿量（不是往右！）
      const cxBox = cx + (dx - CJK_BEARING / 2) * dLng
      const left = cxBox - (boxW / 2) * dLng
      const right = cxBox + (boxW / 2) * dLng
      const bottom = cy - (boxH / 2) * dLat
      const top = cy + (boxH / 2) * dLat
      boxFeats.push({
        type: 'Feature',
        // 2026-09-21（需求方："标签对比度低"）：底块不透明度 0.68 → 0.85。
        //   这个值会**逐要素喂给图层**（覆盖 `textBoxLayers()` 里的缺省），所以两处要一起改。
        properties: { color: '#0a1d33', opacity: 0.85 },
        geometry: { type: 'Polygon', coordinates: [roundedRect(left, bottom, right, top, RADIUS * dLng, RADIUS * dLat)] },
      })
    }
  }

  LayerManager.setTextFeatures({ type: 'FeatureCollection', features: textFeats } as never)
  LayerManager.setTextBoxFeatures({ type: 'FeatureCollection', features: boxFeats } as never)
}

function schedule(): void {
  if (raf) return
  raf = requestAnimationFrame(() => { raf = 0; syncText() })
}

/**
 * 挂上联动（在 `MapView` 里 `LayerManager.init(map)` 之后调用一次即可）：
 *   · 图元增删改显隐 → 文字与底块重算
 *   · **缩放变化 → 必须重算**：底块是地理坐标下的面，不重算就会跟着比例尺一起放大
 *   · 图层分组开关 → 由 `LayerManager.applyVisibility` 回调（`registerVisibilityHook`）
 *
 * ⚠️ 事件不能只挂 `zoom`：实测宿主在 `load` 之后才把视野设到目标缩放，
 *    而那次变化没有走到 `zoom`/`moveend` 上，结果底块是按**旧缩放**算的（框比字大近一倍）。
 *    所以 `idle` / `styledata` 也挂上，并在启动后补几次"沉降期"重算。
 */
export function startTextLayer(): void {
  const map = mapInstance.current
  if (map && map !== boundMap) {
    boundMap = map
    for (const ev of ['zoom', 'moveend', 'idle', 'styledata']) map.on(ev as never, schedule)
  }
  MapDraw.on('change', schedule)
  LayerManager.registerVisibilityHook(schedule)
  syncText()
  for (const ms of [200, 600, 1500, 3000]) window.setTimeout(schedule, ms)
}
