// packages/web/test/thinkingModel.test.ts — event-kind mapping for the
// backend's vitals / watchdog / repeat-guard rounds: plan_created /
// loop_stalled / morning_briefing prefixes, the orphaned-acceptance
// verify_due variant, and the identical-call death-spiral warning riding at
// the tail of tool results. Plus the frameToThinkingSteps chat_out mapping
// that surfaces them as their own timeline step.
import { describe, expect, test } from 'vitest'
import { eventKindOf, eventPayload, frameToThinkingSteps } from '../src/views/thinkingModel'
import { en } from '../src/i18n/en'
import { zh } from '../src/i18n/zh'
import type { ServerFrame } from '../src/state/types'

// minimal label fixture: only the keys the derivation fills — keeps the unit
// independent of dictionary copy while still exercising fill interpolation
const LABELS: Record<string, string> = {
  'ts.reply': 'REPLY — {text}',
  'ts.plan': 'PLAN — {text}',
  'ts.stall': 'STALL — {text}',
  'ts.morning': 'MORNING — {text}',
  'ts.awaiting': 'AWAITING — {text}',
  'ts.stuck': 'STUCK — {text}',
}
const t = (key: string): string => LABELS[key] ?? key

const jexOut = (text: string): ServerFrame =>
  ({ t: 'chat_out', from: 'jex', text, ts: 1_700_000_000_000 }) as ServerFrame

describe('eventKindOf', () => {
  test('backend event prefixes map to their kinds', () => {
    expect(eventKindOf('plan_created: build the site (3 steps) — dispatch the ready steps now')).toBe('plan')
    expect(eventKindOf('loop_stalled: tick frozen 240s — self-recovery wake (check timers, queue and the takeover link)')).toBe('stall')
    expect(eventKindOf('morning_briefing: compose today\'s digest for the human — yesterday\'s acceptance verdicts')).toBe('morning')
  })

  test('verify_due only promotes to awaiting with the orphaned-acceptance marker', () => {
    expect(
      eventKindOf('verify_due: ab12cd34 fix login accept: tests pass [awaiting acceptance since the agent finished — judge it now]'),
    ).toBe('awaiting')
    expect(eventKindOf('verify_due: ab12cd34 fix login accept: tests pass')).toBeNull()
  })

  test('identical-call warning matches at the tail of tool results', () => {
    expect(eventKindOf('tool read_file -> ok [WARNING: identical call #5 — this approach is stuck; stop repeating, reflect a lesson or change method]')).toBe('stuck')
  })

  test('plain lines stay unclassified (reply / reflect / tick handling unchanged)', () => {
    expect(eventKindOf('reflected: cache the scout inventory')).toBeNull()
    expect(eventKindOf('已制定计划「重构」：3 步（首步：盘点）')).toBeNull()
    expect(eventKindOf('tick')).toBeNull()
    expect(eventKindOf('')).toBeNull()
  })
})

describe('eventPayload', () => {
  test('prefix kinds strip the prefix; stuck keeps the full line', () => {
    expect(eventPayload('plan_created: goal (2 steps) — dispatch', 'plan')).toBe('goal (2 steps) — dispatch')
    expect(eventPayload('tool ls -> empty [WARNING: identical call #7 — stuck]', 'stuck')).toBe(
      'tool ls -> empty [WARNING: identical call #7 — stuck]',
    )
  })
})

describe('frameToThinkingSteps (chat_out)', () => {
  test('classified events surface as their own step kind with full detail', () => {
    const steps = frameToThinkingSteps(jexOut('plan_created: build the site (3 steps) — dispatch the ready steps now'), t)
    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind).toBe('plan')
    expect(steps[0]!.label).toContain('PLAN — ')
    expect(steps[0]!.label).toContain('build the site')
    expect(steps[0]!.detail).toBe('plan_created: build the site (3 steps) — dispatch the ready steps now')
  })

  test('all five event kinds round-trip through the chat_out branch', () => {
    const cases: Array<[string, string]> = [
      ['plan_created: g (1 steps) — dispatch', 'plan'],
      ['loop_stalled: tick frozen 300s — self-recovery wake', 'stall'],
      ['morning_briefing: compose the digest', 'morning'],
      ['verify_due: id title accept: x [awaiting acceptance since the agent finished — judge it now]', 'awaiting'],
      ['tool stat -> ok [WARNING: identical call #5 — stuck]', 'stuck'],
    ]
    for (const [text, kind] of cases) {
      expect(frameToThinkingSteps(jexOut(text), t)[0]!.kind, text).toBe(kind)
    }
  })

  test('plain jex chat stays a reply; user chat produces nothing', () => {
    expect(frameToThinkingSteps(jexOut('今天进展如何？'), t)[0]!.kind).toBe('reply')
    expect(
      frameToThinkingSteps({ t: 'chat_out', from: 'user', text: 'plan_created: fake', ts: 1 } as ServerFrame, t),
    ).toEqual([])
  })
})

describe('event-kind dictionary keys', () => {
  test('both dictionaries carry a label for every event kind (badge + step)', () => {
    for (const dict of [zh, en]) {
      for (const k of ['plan', 'stall', 'morning', 'awaiting', 'stuck'] as const) {
        expect(dict[`cc.think.${k}`], `cc.think.${k}`).toBeTruthy()
        expect(dict[`ts.${k}`], `ts.${k}`).toBeTruthy()
      }
    }
  })
})
