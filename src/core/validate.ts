// map-2d · 图元数据校验（需求 M2-NFR-10：错误边界）
//
// 目的：一条脏数据不能拖垮整类图元的渲染。做法是在**入口处**（set/add/batch）逐条校验：
//   · 合法的继续进入集合
//   · 非法的跳过并通过 diagnostics.reportPrimitiveError 上报（含 kind / id / 原因），
//     宿主可以用 mapDiagnostics.onError 收到，或调 recentErrors() 批量查看
// 校验只要求"渲染必需字段"存在且是有限数；样式类字段（颜色/标签）不校验。
import { reportPrimitiveError } from './diagnostics'
import type { PrimitiveKind } from '../primitives/api'

const needNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const needArray = (v: unknown) => Array.isArray(v)

/** 校验单条图元；返回 null 表示合法，否则返回原因字符串 */
export function validatePrimitive(kind: PrimitiveKind, item: unknown): string | null {
  if (!item || typeof item !== 'object') return '不是对象'
  const it = item as Record<string, unknown>
  if (typeof it.id !== 'string' || !it.id) return '缺少 id'

  switch (kind) {
    case 'area': {
      const poly = it.polygon
      if (!needArray(poly) || (poly as unknown[]).length < 3) return 'polygon 顶点少于 3 个'
      for (const p of poly as unknown[]) {
        if (!needArray(p) || (p as unknown[]).length < 2 || !needNumber((p as number[])[0]) || !needNumber((p as number[])[1])) {
          return 'polygon 顶点不是 [lng,lat]'
        }
      }
      return null
    }
    case 'drone':
    case 'target':
    case 'cluster':
    case 'label':
      if (!needNumber(it.lng) || !needNumber(it.lat)) return '缺少有效 lng/lat'
      if (kind === 'label' && typeof it.text !== 'string') return '缺少 text'
      return null
    case 'scan':
      if (!needNumber(it.lng) || !needNumber(it.lat)) return '缺少有效 lng/lat'
      if (!needNumber(it.radiusKm) || (it.radiusKm as number) <= 0) return 'radiusKm 无效'
      return null
    case 'pulse':
      if (!needNumber(it.lng) || !needNumber(it.lat)) return '缺少有效 lng/lat'
      return null
    case 'link':
      for (const k of ['from', 'to'] as const) {
        const p = it[k]
        if (!needArray(p) || (p as unknown[]).length < 2 || !needNumber((p as number[])[0]) || !needNumber((p as number[])[1])) {
          return `${k} 不是 [lng,lat]`
        }
      }
      return null
    case 'track':
      if (!needArray(it.points) || (it.points as unknown[]).length < 2) return 'points 少于 2 个点'
      return null
    case 'route':
      if (!needArray(it.points) || (it.points as unknown[]).length < 2) return '航线 points 少于 2 个点'
      for (const p of it.points as unknown[]) {
        if (!needArray(p) || (p as unknown[]).length < 2 || !needNumber((p as number[])[0]) || !needNumber((p as number[])[1])) {
          return '航线顶点不是 [lng,lat]'
        }
      }
      return null
    case 'shape':
      if (!needNumber(it.lng) || !needNumber(it.lat)) return '缺少有效 lng/lat'
      if (!needNumber(it.radiusKm) || (it.radiusKm as number) <= 0) return 'radiusKm 无效'
      if (it.radiusKmMinor != null && (!needNumber(it.radiusKmMinor) || (it.radiusKmMinor as number) <= 0)) {
        return 'radiusKmMinor 无效'
      }
      return null
    default:
      return null
  }
}

/**
 * 过滤一批图元：返回合法项；非法项逐条上报。
 * 用于 `MapDraw.set` / `add` / `batch` 等入口。
 */
export function filterValid<T extends { id?: unknown }>(
  kind: PrimitiveKind,
  items: T[],
): { valid: T[]; rejected: { id: string; reason: string }[] } {
  const valid: T[] = []
  const rejected: { id: string; reason: string }[] = []
  for (const it of items) {
    const reason = validatePrimitive(kind, it)
    if (reason) {
      const id = typeof it?.id === 'string' ? it.id : '(无 id)'
      rejected.push({ id, reason })
      reportPrimitiveError({ kind, id, reason })
    } else {
      valid.push(it)
    }
  }
  return { valid, rejected }
}
