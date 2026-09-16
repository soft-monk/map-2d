// map-2d · 本批新增能力的真机自证（位图图标 + 缺省画点 / 轨迹线宽）
//
// 覆盖两条必须被证明的断言：
//   ① **不给新字段 → 行为与今天一致**：不登记样式配置时，
//      无人机的圆点半径/描边、轨迹的线宽/透明度必须与改造前的固定取值逐项相同。
//   ② **图标 URL 无效 → 回落为点，且有可读原因**：加载失败不得抛异常、不得整图不显示。
// 外加：有效位图 URL 时确实升级为位图（否则"新增能力"等于没做）。
//
// 为什么放在 `_acceptance/` 而不是 `examples/`：
//   本脚本会被**就地执行**，而它运行期间 `npm run dev` 正在跑。
//   编辑器若在 examples/ 里做原子写，Vite 的 chokidar 会去 watch 一个已被删掉的临时目录，
//   在 Windows 上直接 EBUSY 打挂 dev server。放进这个"不参与打包与监听"的目录可以规避，
//   同时脚本本身仍在模块仓内（满足"验收脚本在模块目录内可执行"的约束）。
//
// 用法（两件事按顺序做）：
//   1) 在 map-2d 目录起独立宿主：  npm run dev            → http://localhost:5180/
//   2) 另开一个终端：              node _acceptance/marker-style-acceptance.mjs
//
// 退出码：0 = 全部断言通过；1 = 有断言失败；2 = 环境不具备（没找到 Chrome）
//
// 说明：本脚本走 Vite dev server 的模块图（`import('/src/index.ts')`），
// 因此测的是**源码**而不是 dist 产物，与 `npm run dev` 下看到的画面同源。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const URL_BASE = process.env.MAP2D_URL ?? 'http://localhost:5180/'
const KEEP = process.argv.includes('--keep')

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p))

if (!CHROME) {
  console.error('[marker-style] 没找到 Chrome —— 这一步是真机自证，环境不具备时跳过（退出码 2）')
  process.exit(2)
}

// ---------------------------------------------------------------- 造两张测试 PNG
//
// 为什么自己造：本能力要证明"位图真的画出来了"，就需要一张**确定存在**的图；
// 仓库里没有自带的 icons 目录，因此这里现场生成一张纯色 PNG（零依赖，靠 zlib 写 IDAT）。
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** 生成一张 w×h 的纯色 PNG（RGBA，8 位） */
function solidPng(w, h, [r, g, b, a = 255]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8      // bit depth
  ihdr[9] = 6      // color type: RGBA
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 4)
    raw[off] = 0   // filter: none
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 4
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const ICON_DIR = path.join(ROOT, 'public', 'icons')
const TEST_ICON = path.join(ICON_DIR, 'acceptance-uav.png')
mkdirSync(ICON_DIR, { recursive: true })
writeFileSync(TEST_ICON, solidPng(28, 28, [34, 211, 238]))
const GOOD_ICON = new URL('icons/acceptance-uav.png', URL_BASE).href
const BAD_ICON = new URL('icons/definitely-missing-404.png', URL_BASE).href

// ---------------------------------------------------------------- CDP
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(path.join(tmpdir(), 'm2-marker-'))
const port = 9400 + (process.pid % 300)

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' })

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(200)
  }
  throw new Error('Chrome 调试端口没起来')
}

let pass = 0
let fail = 0
const results = []
function check(name, ok, detail) {
  ok ? pass++ : fail++
  results.push(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

let browser
try {
  const ws = new WebSocket(await wsUrl())
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  browser = { ws, send }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })
  const s = (method, params = {}) => send(method, params, sessionId)
  await s('Page.enable')
  await s('Runtime.enable')

  /** 在页面里求值（表达式形式，支持 await），返回 { value } 或 { error } */
  async function ev(expression) {
    const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      return { error: String(d).split('\n').slice(0, 3).join(' ⏎ ') }
    }
    return { value: r.result.value }
  }
  /** 轮询直到表达式为真（返回最后一次的值） */
  async function waitFor(expression, ms = 12000) {
    const t0 = Date.now()
    let last
    while (Date.now() - t0 < ms) {
      const r = await ev(expression)
      last = r
      if (r.value) return r
      await sleep(300)
    }
    return last
  }

  await s('Page.navigate', { url: URL_BASE })
  await sleep(1500)

  // 等独立宿主把地图挂起来，并确认验收台在（= 真机环境就绪）
  const boot = await waitFor(`(() => !!document.querySelector('.maplibregl-map canvas'))()`, 40000)
  check('独立宿主已出图（.maplibregl-map canvas 存在）', boot.value === true, JSON.stringify(boot))

  // 取到模块的公开入口（Vite dev server 的原生 ESM 图，与页面同源、同实例）
  const mod = await ev(`(async () => {
    const m = await import('/src/index.ts')
    window.__m2Marker = m
    return ['MapDraw','mapInstance','setStyleConfig','iconFailureCount','iconFailures','resolveMarkerPlan']
      .filter(k => !(k in m))
  })()`)
  check('公开入口可导入且导出齐全', Array.isArray(mod.value) && mod.value.length === 0, JSON.stringify(mod))

  // ================================================================ ① 不给新字段 → 行为与今天一致
  //
  // 注意两点测试侧的口径（否则会得到假失败）：
  //   · `map.querySourceFeatures` 反映的是**上一次瓦片更新**的内容 —— 写完数据要等一拍再读；
  //   · 图层可见性受**阶段**约束（uav 组在 T3–T7 才显示），分组开关断言前先把阶段置成 T3。
  const setup = await ev(`(() => {
    const m = window.__m2Marker
    m.MapDraw.setStyle(null)          // 明确回到"未配置样式"的状态
    // 让无人机/轨迹图层进入"阶段允许显示"的集合：
    //   uav    → recon 阶段（T3–T7）
    //   track  → 模块既有规则里只在 recon + scenario-2 才开（见 phaseVisibleLayers）
    m.LayerManager.setScenario('scenario-2')
    m.LayerManager.setPhase('T3')
    m.MapDraw.clear('drone'); m.MapDraw.clear('track')
    m.MapDraw.add('drone', { id: 'D-NOICON', lng: 116.3974, lat: 39.9093, type: 'radar' })
    m.MapDraw.add('track', { id: 'K-NOWIDTH', points: [[116.36,39.90],[116.40,39.91],[116.44,39.92]] })
    return { drones: m.MapDraw.list('drone').length, tracks: m.MapDraw.list('track').length, cfg: m.MapDraw.getStyle() }
  })()`)

  const baseline = await waitFor(`(() => {
    const m = window.__m2Marker
    const D = (window.__feat = window.__feat || ((src) => {
        const s = m.mapInstance.current.getSource(src)
        return (s && s._data && s._data.features) || []
      }))
    const droneFeat = D('src-uav').find(f => f.properties.id === 'D-NOICON')
    const trackFeat = D('src-track').find(f => f.properties.id === 'K-NOWIDTH')
    if (!droneFeat || !trackFeat) return null
    return {
      styleConfig: m.MapDraw.getStyle(),
      droneProps: droneFeat.properties,
      trackProps: trackFeat.properties,
    }
  })()`, 15000)
  const b = baseline.value ?? {}
  check('未配置样式时 getStyle() 为 null', b.styleConfig === null, JSON.stringify(b.styleConfig))
  check('无人机圆点半径 = 5（改造前取值）', b.droneProps?.radius === 5, `radius=${b.droneProps?.radius}`)
  check('无人机描边色 = #e8f1ff（改造前取值）', b.droneProps?.strokeColor === '#e8f1ff', `strokeColor=${b.droneProps?.strokeColor}`)
  check('无人机描边宽 = 1（改造前取值）', b.droneProps?.strokeWidth === 1, `strokeWidth=${b.droneProps?.strokeWidth}`)
  check('无人机颜色按机型（radar=#f59e0b）', b.droneProps?.color === '#f59e0b', `color=${b.droneProps?.color}`)
  check('无人机未标记位图（hasIcon 不存在）', b.droneProps?.hasIcon === undefined, `hasIcon=${JSON.stringify(b.droneProps?.hasIcon)}`)
  check('轨迹线宽 = 2（改造前取值）', b.trackProps?.width === 2, `width=${b.trackProps?.width}`)
  check('轨迹透明度 = 0.9（改造前取值）', b.trackProps?.lineOpacity === 0.9, `lineOpacity=${b.trackProps?.lineOpacity}`)
  check('轨迹线色 = #ef4444（改造前取值）', b.trackProps?.color === '#ef4444', `color=${b.trackProps?.color}`)
  check('轨迹未给 dashed 时仍为虚线（改造前默认）', b.trackProps?.dash === 1, `dash=${b.trackProps?.dash}`)

  // 图层 paint 里的缺省字面量也必须还是改造前的值（这是"画面不变"的另一半保证）
  const paint = await ev(`(() => {
    const st = window.__m2Marker.mapInstance.current.getStyle()
    const L = (id) => st.layers.find(l => l.id === id)
    return JSON.stringify({
      uavRadius: JSON.stringify(L('lyr-uav').paint['circle-radius']),
      uavStroke: JSON.stringify(L('lyr-uav').paint['circle-stroke-color']),
      uavStrokeW: JSON.stringify(L('lyr-uav').paint['circle-stroke-width']),
      trackWidth: JSON.stringify(L('lyr-track').paint['line-width']),
      trackColor: JSON.stringify(L('lyr-track').paint['line-color']),
      trackOpacity: JSON.stringify(L('lyr-track').paint['line-opacity']),
      trackDash: JSON.stringify(L('lyr-track-dashed').paint['line-dasharray']),
    })
  })()`)
  let p = {}
  try { p = JSON.parse(paint.value) } catch { /* ignore */ }
  check('lyr-uav 缺省取值未变（5 / #e8f1ff / 1）',
    p.uavRadius === '["coalesce",["get","radius"],5]' && p.uavStroke === '["coalesce",["get","strokeColor"],"#e8f1ff"]' && p.uavStrokeW === '["coalesce",["get","strokeWidth"],1]',
    `${p.uavRadius} | ${p.uavStroke} | ${p.uavStrokeW}`)
  check('lyr-track 缺省取值未变（2 / #ef4444 / 0.9 / 虚线 [3,2]）',
    p.trackWidth === '["coalesce",["get","width"],2]' && p.trackColor === '["coalesce",["get","color"],"#ef4444"]'
    && p.trackOpacity === '["coalesce",["get","lineOpacity"],0.9]' && p.trackDash === '[3,2]',
    `${p.trackWidth} | ${p.trackColor} | ${p.trackOpacity} | ${p.trackDash}`)

  // ================================================================ ② 图标 URL 无效 → 回落为点 + 可读原因
  const badIcon = await ev(`(async () => {
    const m = window.__m2Marker
    m.MapDraw.setStyle({ drone: { useIcon: true, icon: { url: ${JSON.stringify(BAD_ICON)}, sizePx: [28,28] } } })
    m.MapDraw.set('drone', [{ id: 'D-BAD', lng: 116.3974, lat: 39.9093, type: 'optical' }])
    return true
  })()`)
  check('登记"坏图标"配置未抛异常', badIcon.value === true, JSON.stringify(badIcon))

  // 先等到"失败被记下来"再读快照：加载失败是异步的，降级记录随后续快照刷新，
  // 所以这里轮询的是累计失败计数（而不是那一次快照的瞬间状态）。
  const badFailed = await waitFor(`window.__m2Marker.iconFailureCount() >= 1 ? window.__m2Marker.iconFailures() : null`, 15000)
  const fails = badFailed.value ?? []
  check('坏图标：加载失败被计数', fails.length >= 1, `iconFailureCount=${fails.length}`)
  check('坏图标：失败原因可读（含 HTTP 状态或错误文本）',
    typeof fails[0]?.reason === 'string' && fails[0].reason.length > 0,
    `reason=${JSON.stringify(fails[0]?.reason)} url=${fails[0]?.url}`)

  const afterBad = await waitFor(`(() => {
    const m = window.__m2Marker
    const map = m.mapInstance.current
    const s = map.getSource('src-uav')
    const f = ((s && s._data && s._data.features) || []).find(x => x.properties.id === 'D-BAD')
    if (!f) return null
    const st = map.getStyle()
    return {
      hasIcon: f.properties.hasIcon === true,
      radius: f.properties.radius,
      strokeColor: f.properties.strokeColor,
      strokeWidth: f.properties.strokeWidth,
      degraded: m.MapDraw.degradedIcons(),
      failureCount: m.iconFailureCount(),
      iconStats: m.MapDraw.iconStats(),
      pointLayerFilter: st.layers.find(l => l.id === 'lyr-uav').filter,
      trackLayerStillOk: !!st.layers.find(l => l.id === 'lyr-track'),
      droneCount: m.MapDraw.list('drone').length,
    }
  })()`, 15000)
  const ab = afterBad.value ?? null
  check('坏图标：图元仍在（没有整图消失）', !!ab && ab.droneCount === 1, JSON.stringify(afterBad).slice(0, 300))
  check('坏图标：回落为点（未标 hasIcon）', ab?.hasIcon === false, `hasIcon=${ab?.hasIcon}`)
  check('坏图标：点的半径/描边按缺省（5 / #e8f1ff / 1）',
    ab?.radius === 5 && ab?.strokeColor === '#e8f1ff' && ab?.strokeWidth === 1,
    `radius=${ab?.radius} stroke=${ab?.strokeColor}/${ab?.strokeWidth}`)
  check('坏图标：降级原因挂到图元 id 上（可读，指向该 URL）',
    Array.isArray(ab?.degraded) && ab.degraded.length >= 1 && String(ab.degraded[0]?.reason ?? '').length > 0,
    JSON.stringify(ab?.degraded))
  check('坏图标：其余图层未受影响（轨迹层仍在）', ab?.trackLayerStillOk === true, `trackLayerStillOk=${ab?.trackLayerStillOk}`)

  // ================================================================ ③ 有效位图 → 真的升级为位图
  const goodIcon = await ev(`(async () => {
    const m = window.__m2Marker
    m.MapDraw.setStyle({ drone: { useIcon: true, icon: { url: ${JSON.stringify(GOOD_ICON)}, sizePx: [28,28], anchor: 'center' } } })
    m.MapDraw.set('drone', [{ id: 'D-GOOD', lng: 116.3974, lat: 39.9093, type: 'optical' }])
    return true
  })()`)
  check('登记"好图标"配置未抛异常', goodIcon.value === true, JSON.stringify(goodIcon))

  const afterGood = await waitFor(`(() => {
    const m = window.__m2Marker
    const map = m.mapInstance.current
    const s = map.getSource('src-uav')
    const f = ((s && s._data && s._data.features) || []).find(x => x.properties.id === 'D-GOOD')
    if (!f || f.properties.hasIcon !== true) return null
    const st = map.getStyle()
    return {
      hasIcon: true,
      icon: f.properties.icon,
      iconSize: f.properties.iconSize,
      iconAnchor: f.properties.iconAnchor,
      imageRegistered: !!map.getImage(f.properties.icon),
      iconLayerFilter: st.layers.find(l => l.id === 'lyr-uav-icon').filter,
      iconLayerImage: st.layers.find(l => l.id === 'lyr-uav-icon').layout['icon-image'],
      stats: m.MapDraw.iconStats(),
    }
  })()`, 15000)
  const ag = afterGood.value ?? null
  check('好图标：要素升级为位图（hasIcon=true）', ag?.hasIcon === true, JSON.stringify(afterGood).slice(0, 300))
  check('好图标：图片已注册进 MapLibre', ag?.imageRegistered === true, `icon=${ag?.icon}`)
  check('好图标：icon-size 按 sizePx 换算（28/24）', Math.abs((ag?.iconSize ?? 0) - 28 / 24) < 1e-6, `iconSize=${ag?.iconSize}`)
  check('好图标：icon-anchor 取配置值', ag?.iconAnchor === 'center', `anchor=${ag?.iconAnchor}`)
  check('好图标：位图/画点计数正确（1 位图 / 0 点）',
    ag?.stats?.lastMode?.icon === 1 && ag?.stats?.lastMode?.point === 0, JSON.stringify(ag?.stats))

  // ================================================================ ④ 轨迹线宽（M2）
  await ev(`(() => {
    const m = window.__m2Marker
    m.MapDraw.setStyle({ track: { widthPx: 2, dashed: false, color: '#38bdf8', opacity: 0.85 } })
    m.MapDraw.set('track', [
      { id: 'K-CONF', points: [[116.36,39.90],[116.40,39.91]] },                       // 不传 widthPx → 用配置的 2
      { id: 'K-W6',   points: [[116.36,39.92],[116.40,39.93]], widthPx: 6 },           // 图元字段优先于配置
      { id: 'K-DASH', points: [[116.36,39.94],[116.40,39.95]], dashed: true, widthPx: 4 },
    ])
    return true
  })()`)
  const track = await waitFor(`(() => {
    const m = window.__m2Marker
    const map = m.mapInstance.current
    const s = map.getSource('src-track')
    const feats = (s && s._data && s._data.features) || []
    const byId = (id) => feats.find(f => f.properties.id === id)
    const conf = byId('K-CONF'), w6 = byId('K-W6'), dash = byId('K-DASH')
    if (!conf || !w6 || !dash) return null
    const st = map.getStyle()
    const solid = st.layers.find(l => l.id === 'lyr-track')
    const dashed = st.layers.find(l => l.id === 'lyr-track-dashed')
    return {
      conf: conf.properties, w6: w6.properties, dash: dash.properties,
      solidFilter: JSON.stringify(solid.filter), dashedFilter: JSON.stringify(dashed.filter),
    }
  })()`, 15000)
  const t = track.value ?? {}
  check('轨迹：不传 widthPx → 用配置 widthPx(2)', t.conf?.width === 2, `width=${t.conf?.width}`)
  check('轨迹：不传 widthPx → 用配置 color/opacity',
    t.conf?.color === '#38bdf8' && t.conf?.lineOpacity === 0.85,
    `color=${t.conf?.color} opacity=${t.conf?.lineOpacity}`)
  check('轨迹：图元 widthPx 优先于配置（6）', t.w6?.width === 6, `width=${t.w6?.width}`)
  check('轨迹：dashed 走虚线层（dash=1）', t.dash?.dash === 1, `dash=${t.dash?.dash}`)
  check('轨迹：配置 dashed:false 时实线（dash=0）', t.conf?.dash === 0, `dash=${t.conf?.dash}`)
  check('轨迹：实/虚两层用 dash 数字分流（!=1 / ==1）',
    t.solidFilter === '["!=",["get","dash"],1]' && t.dashedFilter === '["==",["get","dash"],1]',
    `solid=${t.solidFilter} dashed=${t.dashedFilter}`)

  // 图层分组开关要能一起管住新的虚线层（避免"关不掉"）
  // 前置：阶段已在 ① 段置为 T3，此时 uav/track 图层都在"阶段允许显示"的集合里，
  // 所以下面的隐藏/显示差异确实来自分组开关本身。
  const group = await ev(`(() => {
    const m = window.__m2Marker
    const map = m.mapInstance.current
    m.LayerManager.setGroupVisible('track', false)
    const off = [map.getLayoutProperty('lyr-track','visibility'), map.getLayoutProperty('lyr-track-dashed','visibility')]
    m.LayerManager.setGroupVisible('track', true)
    const on = [map.getLayoutProperty('lyr-track','visibility'), map.getLayoutProperty('lyr-track-dashed','visibility')]
    return { off, on, labels: m.LAYER_GROUP_LABELS.track }
  })()`)
  const g = group.value ?? {}
  check('轨迹分组开关同时管住实线层与虚线层',
    JSON.stringify(g.off) === JSON.stringify(['none', 'none']) && JSON.stringify(g.on) === JSON.stringify(['visible', 'visible']),
    `track: off=${JSON.stringify(g.off)} on=${JSON.stringify(g.on)}；uav: `)

  const uavGroup = await ev(`(() => {
    const m = window.__m2Marker
    const map = m.mapInstance.current
    m.LayerManager.setGroupVisible('uav', false)
    const off = map.getLayoutProperty('lyr-uav-icon','visibility')
    m.LayerManager.setGroupVisible('uav', true)
    return { off, on: map.getLayoutProperty('lyr-uav-icon','visibility') }
  })()`)
  check('无人机分组开关同时管住位图层', uavGroup.value?.off === 'none' && uavGroup.value?.on === 'visible',
    `lyr-uav-icon: off=${uavGroup.value?.off} on=${uavGroup.value?.on}`)

  // ================================================================ ⑤ 收尾：清配置后回到基线
  const restore = await ev(`(() => {
    const m = window.__m2Marker
    const map = m.mapInstance.current
    m.MapDraw.setStyle(null)
    m.MapDraw.set('drone', [{ id: 'D-END', lng: 116.3974, lat: 39.9093, type: 'optical' }])
    const s = map.getSource('src-uav')
    const f = ((s && s._data && s._data.features) || []).find(x => x.properties.id === 'D-END')
    return { hasIcon: f?.properties.hasIcon, radius: f?.properties.radius, cfg: m.MapDraw.getStyle(),
             hasIconKey: f ? Object.prototype.hasOwnProperty.call(f.properties, 'hasIcon') : null }
  })()`)
  check('清除配置后立刻回到"画点"基线',
    restore.value?.cfg === null && restore.value?.hasIconKey === false && restore.value?.radius === 5,
    JSON.stringify(restore.value))

  check('全程没有未捕获的 console.error（异常会在这里露出来）',
    consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || ') || '（无）')
} catch (e) {
  check('脚本自身执行', false, String(e?.message ?? e))
} finally {
  try { browser?.ws?.close() } catch { /* ignore */ }
  try { chrome.kill() } catch { /* ignore */ }
  if (!KEEP) {
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
    // 只删本脚本自己生成的这张图 + 目录为空时才删目录。
    // （踩过的坑：早先整目录删掉，把 demo-icons/ 之外放在 public/icons 里的文件一起带走了）
    try { rmSync(TEST_ICON, { force: true }) } catch { /* ignore */ }
    try { if (readdirSync(ICON_DIR).length === 0) rmSync(ICON_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log(`[marker-style] url=${URL_BASE}${KEEP ? '  --keep（保留临时 profile 与 icons/）' : ''}`)
for (const r of results) console.log('  ' + r)
console.log(`[marker-style] 通过 ${pass} / 失败 ${fail}`)
console.log(fail === 0
  ? '[marker-style] PASS：位图图标可用；不给新字段时行为不变；URL 无效时回落为点且有可读原因'
  : '[marker-style] FAIL：见上表')
process.exit(fail === 0 ? 0 : 1)
