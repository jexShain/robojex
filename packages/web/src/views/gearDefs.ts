// packages/web/src/views/gearDefs.ts — static fallback gear table used when
// GET /api/gear has not answered yet (or the backend predates gears). Mirrors
// ceo-core gears.ts / SPEC-DESKTOP.md §2.2.

import type { GearDef } from '../state/types'

export const GEAR_FALLBACK: GearDef[] = [
  {
    id: 'dormant',
    level: 0,
    name: '休眠',
    emoji: '😴',
    tickMs: 0,
    decideMaxTokens: 0,
    patrolEvery: 0,
    desc: '不巡逻不决策，只响应直聊；jex「睡着了」',
    cost: '≈ 0',
  },
  {
    id: 'eco',
    level: 1,
    name: '省电',
    emoji: '🌱',
    tickMs: 300_000,
    decideMaxTokens: 2048,
    patrolEvery: 5,
    desc: '极省 token：只看关键事件，动作保守',
    cost: '极低',
  },
  {
    id: 'balanced',
    level: 2,
    name: '均衡',
    emoji: '⚖️',
    tickMs: 60_000,
    decideMaxTokens: 4096,
    patrolEvery: 1,
    desc: '默认挡位：正常自主，平衡成本',
    cost: '中等',
  },
  {
    id: 'focused',
    level: 3,
    name: '专注',
    emoji: '🎯',
    tickMs: 30_000,
    decideMaxTokens: 8192,
    patrolEvery: 1,
    desc: '主动推进任务板，愿意 spawn，深入思考',
    cost: '较高',
  },
  {
    id: 'turbo',
    level: 4,
    name: '狂暴',
    emoji: '🚀',
    tickMs: 15_000,
    decideMaxTokens: 16384,
    patrolEvery: 1,
    desc: '最大自主：自我发起任务、自我审计、全速燃烧',
    cost: '高',
  },
]

/** Live gears when loaded, fallback otherwise. */
export function gearsOrFallback(gears: GearDef[]): GearDef[] {
  return gears.length > 0 ? gears : GEAR_FALLBACK
}
