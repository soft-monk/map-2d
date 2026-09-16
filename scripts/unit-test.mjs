// map-2d · 纯函数单元测试（需求 M2-NFR-05 的补充：可构建性之外的"可验证性"）
//
// 为什么要有：纯函数（几何/聚类/简化/坐标换算）的正确性不该只靠浏览器里的手点验证。
// 这里用 Node 直接跑（**零依赖**：把待测函数以最小方式内联复制，避免引入测试框架与构建链）。
//
// ⚠️ 注意：本文件内联的是**算法副本**，用于"公式对不对"的回归；它与 src 的同步靠人工。
// 之所以这么做，是因为模块交付约束是"整目录可拷贝、无额外依赖"，引入 vitest/tsx 会破坏它。
// 若将来接受 devDependency，应改成直接 import src。
//
// 用法：node scripts/unit-test.mjs
const R = 6371008.8
const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

const distanceMeters = (a, b) => {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

const polygonAreaM2 = (ring) => {
  const pts = ring.length > 2 && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
    ? [...ring, ring[0]] : ring
  if (pts.length < 4) return 0
  let total = 0
  for (let i = 0; i < pts.length - 1; i++) {
    total += rad(pts[i + 1][0] - pts[i][0]) * (2 + Math.sin(rad(pts[i][1])) + Math.sin(rad(pts[i + 1][1])))
  }
  return Math.abs((total * R * R) / 2)
}

const bearingDeg = (a, b) => {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]))
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]))
  return (deg(Math.atan2(y, x)) + 360) % 360
}

const simplifyPath = (points, tolerance) => {
  if (points.length <= 2 || tolerance <= 0) return points
  const sqTol = tolerance * tolerance
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1]
    let dx = b[0] - x, dy = b[1] - y
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
      if (t > 1) { x = b[0]; y = b[1] } else if (t > 0) { x += dx * t; y += dy * t }
    }
    dx = p[0] - x; dy = p[1] - y
    return dx * dx + dy * dy
  }
  const step = (first, last, out) => {
    let maxSq = sqTol, index = -1
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(points[i], points[first], points[last])
      if (sq > maxSq) { index = i; maxSq = sq }
    }
    if (index > 0) {
      if (index - first > 1) step(first, index, out)
      out.push(index)
      if (last - index > 1) step(index, last, out)
    }
  }
  const out = [0]
  step(0, points.length - 1, out)
  out.push(points.length - 1)
  return out.map((i) => points[i])
}

const sample = (items, n) => {
  if (items.length <= n) return items
  const out = []
  const st = items.length / n
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * st)])
  const last = items[items.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

const toUTM = (lng, lat) => {
  const a = 6378137.0, f = 1 / 298.257223563, e2 = 2 * f - f * f, k0 = 0.9996
  const zone = Math.floor((lng + 180) / 6) + 1
  const lon0 = ((zone - 1) * 6 - 180 + 3) * rad(1) * (Math.PI / Math.PI)
  const phi = rad(lat), lam = rad(lng)
  const ep2 = e2 / (1 - e2)
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - rad((zone - 1) * 6 - 180 + 3))
  const M = a * ((1 - e2 / 4 - (3 * e2 * e2) / 64) * phi
    - ((3 * e2) / 8 + (3 * e2 * e2) / 32) * Math.sin(2 * phi)
    + ((15 * e2 * e2) / 256) * Math.sin(4 * phi))
  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000
  let northing = k0 * (M + N * Math.tan(phi) * ((A * A) / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720))
  if (lat < 0) northing += 10000000
  return { zone, easting, northing }
}

// ---- 断言 ----
let pass = 0, fail = 0
const near = (a, b, tol, name) => {
  const ok = Math.abs(a - b) <= tol
  console.log(`${ok ? '✓' : '✗'} ${name}：实测 ${a} ，期望 ${b} ±${tol}`)
  ok ? pass++ : fail++
}
const eq = (a, b, name) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  console.log(`${ok ? '✓' : '✗'} ${name}：实测 ${JSON.stringify(a)} ，期望 ${JSON.stringify(b)}`)
  ok ? pass++ : fail++
}

console.log('== 几何：距离 ==')
near(distanceMeters([116.3974, 39.9093], [121.4737, 31.2304]) / 1000, 1068.2, 2, '北京→上海（km，公开值约 1064–1070）')
near(distanceMeters([116.4, 39.0], [116.4, 40.0]), 111195, 30, '1° 纬度（m）')
// 期望值推导：R·Δλ(rad)·cosφ = 6371008.8 × 0.1×π/180 × cos(39.9°) = 8530.4 m
// （此前写成 8517.6 是按 111320×cos 的粗略估算，偏小 13 m——是期望值错，不是实现错）
near(distanceMeters([116.4, 39.9], [116.5, 39.9]), 8530.4, 5, '0.1° 经度 @39.9°N（m）')

console.log('\n== 几何：面积 ==')
near(polygonAreaM2([[116.4, 39.9], [116.5, 39.9], [116.5, 40.0], [116.4, 40.0]]) / 1e6, 94.8, 0.5, '0.1°×0.1° @40°N（km²）')
eq(Math.round(polygonAreaM2([[116.4, 39.9], [116.5, 39.9]])), 0, '顶点不足返回 0')

console.log('\n== 几何：方位角 ==')
near(bearingDeg([116.4, 39.9], [116.5, 39.9]), 90, 0.1, '正东 = 90°')
near(bearingDeg([116.4, 39.9], [116.4, 40.0]), 0, 0.1, '正北 = 0°')
near(bearingDeg([116.4, 39.9], [116.3, 39.9]), 270, 0.1, '正西 = 270°')

console.log('\n== 简化（道格拉斯-普克）==')
eq(simplifyPath(Array.from({ length: 100 }, (_, i) => [116.3 + i * 1e-3, 39.9]), 0.01).length, 2, '直线简化到 2 点')
eq(simplifyPath([[116.3, 39.9], [116.35, 39.9], [116.35, 39.95]], 0.001).length, 3, '拐点被保留')
eq(simplifyPath([[116.3, 39.9], [116.35, 39.9]], 0.01).length, 2, '两点直通')

console.log('\n== 抽稀 ==')
const s = sample(Array.from({ length: 1000 }, (_, i) => i), 100)
eq(s[0], 0, '首元素保留')
eq(s[s.length - 1], 999, '尾元素保留')
eq(s.length <= 101, true, '长度不超过 n+1')

console.log('\n== 坐标换算（UTM）==')
const bj = toUTM(116.3974, 39.9093)
eq(bj.zone, 50, '北京带号 = 50')
near(bj.easting, 448494, 60, '北京东距（m）')
near(bj.northing, 4417864, 60, '北京北距（m）')

// ---------------------------------------------------------------------------
// 本批新增：位图图标 + 缺省画点 / 轨迹线宽（对应 src/core/markerIcon.ts）
//
// 与文件顶部的说明一致：这里是**算法副本**（人工与 src 同步），用来回归"公式对不对"。
// 端到端（真的画在位图上、URL 无效真的回落到点）由
// `node _acceptance/marker-style-acceptance.mjs` 在无头 Chrome 里证明。
// ---------------------------------------------------------------------------
const ICON_DEFAULTS = { size: [24, 24], anchor: 'center' }
const POINT_DEFAULTS = { radiusPx: 5, strokeColor: '#e8f1ff', strokeWidthPx: 1 }
const TRACK_DEFAULTS = { widthPx: 2, opacity: 0.9 }

const iconImageName = (url) => `m2icon-${url.replace(/[^A-Za-z0-9._-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`)}`

const normalizeSize = (size) => {
  if (!Array.isArray(size) || size.length < 2) return [...ICON_DEFAULTS.size]
  const [w, h] = size
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [...ICON_DEFAULTS.size]
  return [w, h]
}

const mergeMarkerConfig = (base, over) => {
  if (!base) return over ?? {}
  if (!over) return base
  return {
    useIcon: over.useIcon ?? base.useIcon,
    icon: (base.icon || over.icon) ? { ...base.icon, ...over.icon } : undefined,
    point: (base.point || over.point) ? { ...base.point, ...over.point } : undefined,
  }
}

const resolveMarkerPlan = (item, cfg, typeOverride) => {
  const type = typeOverride ?? item.type
  const merged = mergeMarkerConfig(cfg, type && cfg?.byType ? cfg.byType[type] : undefined)
  const p = merged.point ?? {}
  const plan = {
    mode: 'point',
    radiusPx: item.radiusPx ?? p.radiusPx ?? POINT_DEFAULTS.radiusPx,
    color: item.color ?? p.color,
    strokeColor: p.strokeColor ?? POINT_DEFAULTS.strokeColor,
    strokeWidthPx: p.strokeWidthPx ?? POINT_DEFAULTS.strokeWidthPx,
    matchedType: type && cfg?.byType?.[type] ? type : undefined,
  }
  if (!merged.useIcon) { plan.fallbackReason = cfg ? 'useIcon=false' : '未配置样式（默认画点）'; return plan }
  const url = merged.icon?.url
  if (!url) { plan.fallbackReason = 'icon.url 缺失'; return plan }
  plan.mode = 'icon'
  plan.url = url
  plan.image = iconImageName(url)
  plan.sizePx = normalizeSize(merged.icon?.sizePx)
  plan.anchor = merged.icon?.anchor ?? ICON_DEFAULTS.anchor
  return plan
}

/** 轨迹：解析优先级 = 图元字段 > 样式配置 > 内置缺省 */
const resolveTrackPlan = (item, cfg) => ({
  width: item.widthPx ?? cfg?.widthPx ?? TRACK_DEFAULTS.widthPx,
  opacity: item.opacity ?? cfg?.opacity ?? TRACK_DEFAULTS.opacity,
  color: item.color ?? cfg?.color ?? '#ef4444',
  dash: (item.dashed ?? cfg?.dashed ?? true) ? 1 : 0,
})

console.log('\n== ① 不给新字段 → 行为与今天一致（位图图标 / 轨迹线宽）==')
const planNone = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, type: 'radar' }, undefined)
eq(planNone.mode, 'point', '未配置样式 → 画点（不走位图）')
eq(planNone.radiusPx, 5, '未配置样式 → 圆点半径 = 5（改造前 lyr-uav 的取值）')
eq(planNone.strokeColor, '#e8f1ff', '未配置样式 → 描边色 = #e8f1ff（改造前取值）')
eq(planNone.strokeWidthPx, 1, '未配置样式 → 描边宽 = 1（改造前取值）')
eq(planNone.color, undefined, '未配置样式 → 不写 color（交给内置机型调色板，保持改造前行为）')
eq(planNone.image, undefined, '未配置样式 → 不产生图片名（不会去注册任何图片）')

const tpNone = resolveTrackPlan({ id: 'K', points: [[0, 0], [1, 1]] }, undefined)
eq(tpNone.width, 2, '未配置样式 → 轨迹线宽 = 2（改造前 lyr-track 的取值）')
eq(tpNone.opacity, 0.9, '未配置样式 → 轨迹透明度 = 0.9（改造前取值）')
eq(tpNone.dash, 1, '未配置样式 → 轨迹仍为虚线（改造前默认）')

const tpItem = resolveTrackPlan({ id: 'K', points: [[0, 0], [1, 1]], widthPx: 6 }, { widthPx: 2 })
eq(tpItem.width, 6, '图元 widthPx 优先于样式配置')
const tpCfg = resolveTrackPlan({ id: 'K', points: [[0, 0], [1, 1]] }, { widthPx: 3, dashed: false, opacity: 0.5 })
eq([tpCfg.width, tpCfg.opacity, tpCfg.dash], [3, 0.5, 0], '未给 widthPx 时用配置（线宽/透明度/实线）')

console.log('\n== ①b 降级：URL 缺失 / useIcon=false → 回落画点且有可读原因 ==')
const planNoUrl = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0 }, { useIcon: true, icon: { sizePx: [28, 28] } })
eq(planNoUrl.mode, 'point', 'useIcon=true 但缺 icon.url → 画点')
eq(planNoUrl.fallbackReason, 'icon.url 缺失', '缺 url 的回落原因可读')
const planOff = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0 }, { useIcon: false, icon: { url: '/icons/a.png' } })
eq(planOff.mode, 'point', 'useIcon=false → 画点（即使 url 有效）')
eq(planOff.fallbackReason, 'useIcon=false', 'useIcon=false 的回落原因可读')

console.log('\n== ①c 位图生效时的解析 ==')
const planOn = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0 }, { useIcon: true, icon: { url: '/icons/uav.png', sizePx: [28, 28], anchor: 'bottom' } })
eq(planOn.mode, 'icon', 'useIcon=true 且 url 有效 → 走位图')
eq(planOn.sizePx, [28, 28], 'sizePx 按配置')
eq(planOn.anchor, 'bottom', 'anchor 按配置')
eq(planOn.image, 'm2icon-_2ficons_2fuav.png', '图片名由 URL 编码而来（/ → _2f）')
const planBadSize = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0 }, { useIcon: true, icon: { url: '/a.png', sizePx: [0, -3] } })
eq(planBadSize.sizePx, [24, 24], '非法 sizePx → 回落默认 24×24（不抛异常）')
eq(iconImageName('a b#c'), iconImageName('a b#c'), '同一 URL → 同一图片名（注册幂等）')

console.log('\n== ①d byType 按机型覆盖（逐字段浅合并）==')
const cfgByType = {
  useIcon: false,
  point: { radiusPx: 5, color: '#22d3ee', strokeColor: '#0b1220', strokeWidthPx: 1 },
  byType: { radar: { point: { color: '#f59e0b' } }, comm: { useIcon: true, icon: { url: '/icons/comm.png' } } },
}
const pRadar = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, type: 'radar' }, cfgByType)
eq(pRadar.color, '#f59e0b', 'byType.radar 覆盖 color')
eq(pRadar.radiusPx, 5, 'byType 未写的字段继承顶层（半径）')
eq(pRadar.strokeColor, '#0b1220', 'byType 未写的字段继承顶层（描边色）')
eq(pRadar.matchedType, 'radar', '记录命中的机型键')
const pOptical = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, type: 'optical' }, cfgByType)
eq(pOptical.color, '#22d3ee', '未登记在 byType 的机型用顶层 color')
eq(pOptical.matchedType, undefined, '未命中机型时不记 matchedType')
const pComm = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, type: 'comm' }, cfgByType)
eq(pComm.mode, 'icon', 'byType 可单独开启某机型的位图')
eq(pComm.url, '/icons/comm.png', 'byType 开启位图时用该机型自己的 url')
const pOverride = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, type: 'optical' }, cfgByType, 'radar')
eq(pOverride.color, '#f59e0b', 'typeOverride 覆盖图元自身的 type')
const pItemColor = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, type: 'radar', color: '#123456' }, cfgByType)
eq(pItemColor.color, '#123456', '图元自身 color 优先于样式配置')
const pItemRadius = resolveMarkerPlan({ id: 'D', lng: 0, lat: 0, radiusPx: 9 }, cfgByType)
eq(pItemRadius.radiusPx, 9, '图元自身 radiusPx 优先于样式配置')

console.log(`\n合计：通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
