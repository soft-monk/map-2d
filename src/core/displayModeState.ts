// map-2d · 显示模式：阶段自动推导 + 宿主手动覆盖（需求 M2-CTRL-09）
//
// 语义（在需求里写明的优先级）：
//   1. **手动指定优先**：一旦宿主调用 setDisplayMode(mode)，后续场景/阶段变化不再改它；
//   2. 手动模式下仍会更新"阶段推导值"（reason），便于宿主展示"当前阶段本该是什么"；
//   3. clearDisplayModeOverride() 解除手动，立即回落到阶段推导值；
//   4. 场景切换（scenarioKey 变化）视为"换了一个任务"，**自动解除手动覆盖**——
//      否则会把上一个任务的模式带到新任务里，容易误导。
import { useMapUiStore } from './store'
import { displayModeOf, DISPLAY_MODE as DISPLAY_MODE_TABLE } from './displayMode'
import type { Phase, ScenarioKey } from './types'

export interface DisplayModeState {
  /** 当前生效值 */
  mode: string
  /** 是否处于手动指定 */
  manual: boolean
  /** 阶段推导值（未手动时与 mode 相同） */
  derived: string
  scenarioKey: ScenarioKey
  phase: Phase
}

let manual: string | null = null
let derived = '综合态势'
let lastScenario: ScenarioKey | null = null
let lastPhase: Phase | null = null

/**
 * 场景/阶段变化时调用：更新推导值。
 * - 未手动：直接把 mode 设为推导值；
 * - 已手动：只更新 derived，不动 mode；
 * - 场景变了：解除手动覆盖（换任务了）。
 */
export function syncDisplayMode(scenarioKey: ScenarioKey, phase: Phase): DisplayModeState {
  derived = displayModeOf(scenarioKey, phase)
  if (lastScenario !== null && lastScenario !== scenarioKey) manual = null
  lastScenario = scenarioKey
  lastPhase = phase
  const mode = manual ?? derived
  useMapUiStore.getState().setDisplayMode(mode)
  return state(scenarioKey, phase)
}

/** 手动指定显示模式（优先于阶段推导） */
export function setDisplayModeManual(mode: string): DisplayModeState {
  manual = mode
  useMapUiStore.getState().setDisplayMode(mode)
  return state(lastScenario ?? '', lastPhase ?? 'T0')
}

/** 解除手动覆盖，回落到阶段推导值 */
export function clearDisplayModeOverride(): DisplayModeState {
  manual = null
  useMapUiStore.getState().setDisplayMode(derived)
  return state(lastScenario ?? '', lastPhase ?? 'T0')
}

/** 当前显示模式状态（mode / 是否手动 / 推导值） */
export function displayModeState(): DisplayModeState {
  return state(lastScenario ?? '', lastPhase ?? 'T0')
}

function state(scenarioKey: ScenarioKey, phase: Phase): DisplayModeState {
  return { mode: manual ?? derived, manual: manual !== null, derived, scenarioKey, phase }
}

/** 可选模式清单（供宿主做下拉；取自内置表里的全部取值，去重保序） */
export function availableDisplayModes(): string[] {
  const out: string[] = []
  for (const byPhase of Object.values(DISPLAY_MODE_TABLE)) {
    for (const m of Object.values(byPhase)) if (!out.includes(m)) out.push(m)
  }
  return out
}

/** 测试/重置用 */
export function resetDisplayMode() {
  manual = null
  derived = '综合态势'
  lastScenario = null
  lastPhase = null
}
