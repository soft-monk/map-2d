// map-2d · 显示模式定义（随场景/阶段变化的语义标签）
import type { Phase, ScenarioKey } from './types'

export const DISPLAY_MODE: Record<string, Record<Phase, string>> = {
  'scenario-1': {
    T0: '综合态势', T1: '综合态势', T2: '链路拓扑', T3: '侦察展开',
    T4: '目标识别', T5: '任务规划', T6: '实时态势', T7: '复核态势',
  },
  'scenario-2': {
    T0: '综合态势', T1: '综合态势', T2: '云边端拓扑', T3: '边缘融合态势',
    T4: '目标识别', T5: '任务规划', T6: '引导控制', T7: '结果汇总',
  },
}

export function displayModeOf(scenarioKey: ScenarioKey, phase: Phase): string {
  return DISPLAY_MODE[scenarioKey]?.[phase] ?? '综合态势'
}
