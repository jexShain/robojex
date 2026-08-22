// packages/web/src/views/gearDefs.ts — static fallback gear table used when
// GET /api/gear has not answered yet (or the backend predates gears). Mirrors
// ceo-core gears.ts / SPEC-DESKTOP.md §2.2. Display strings (name/desc/cost)
// are localized through the i18n dictionaries — gear.N.* — so an English UI
// shows Turbo while the backend keeps sending 狂暴.

import type { GearDef } from '../state/types'
import { translate } from '../i18n/event'

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

/** dict lookup with a graceful fallback for gear ids the dictionaries
 * predate (a missing key surfaces as 'gear.<id>.name', which starts with
 * 'gear.' — hand the raw value back in that case). */
function pick(key: string, fallback: string): string {
  const v = translate(key)
  return v === key ? fallback : v
}

/** Localized display name for a gear id (non-React call sites). */
export function gearDisplayName(id: string): string {
  return pick(`gear.${id}.name`, id)
}

/** Replace a gear's display fields with dictionary strings (React call
 * sites pass their live t() so the result re-renders on language switch). */
export function localizeGear(g: GearDef, t: (key: string) => string): GearDef {
  const name = t(`gear.${g.id}.name`)
  const desc = t(`gear.${g.id}.desc`)
  const cost = t(`gear.${g.id}.cost`)
  const miss = (v: string, key: string): boolean => v === key || v.startsWith('gear.')
  return {
    ...g,
    name: miss(name, `gear.${g.id}.name`) ? g.name : name,
    desc: miss(desc, `gear.${g.id}.desc`) ? g.desc : desc,
    cost: miss(cost, `gear.${g.id}.cost`) ? g.cost : cost,
  }
}

/** Localize a whole table (fallback-aware). */
export function localizeGears(gears: GearDef[], t: (key: string) => string): GearDef[] {
  return gears.map((g) => localizeGear(g, t))
}
