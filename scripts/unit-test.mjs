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

console.log(`\n合计：通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
