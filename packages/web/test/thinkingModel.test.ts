// packages/web/test/thinkingModel.test.ts — event-kind mapping for the
// backend's vitals / watchdog / repeat-guard rounds: plan_created /
// loop_stalled / morning_briefing prefixes, the orphaned-acceptance
// verify_due variant, and the identical-call death-spiral warning riding at
// the tail of tool results. Plus the frameToThinkingSteps chat_out mapping
// that surfaces them as their own timeline step.
import { describe, expect, test } from 'vitest'
import { eventKindOf, eventPayload, fmtTokens, frameToThinkingSteps, traceToThinkingStep } from '../src/views/thinkingModel'
import { en } from '../src/i18n/en'
import { zh } from '../src/i18n/zh'
import type { ServerFrame, ThinkStep } from '../src/state/types'

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

/* ── T7: backend trace step → timeline mapping (the live thinking stream) ── */

const TRACE_LABELS: Record<string, string> = {
  'ts.wake': 'WAKE #{n}',
  'ts.patrolVerdict': 'PATROL {verdict} · {n}',
  'ts.decisionPlan': 'PLAN {n}',
  'ts.spawn': 'SPAWN — {title}',
  'ts.doneOk': 'OK — {title}',
  'ts.doneFail': 'FAIL — {title}',
  'ts.audit': 'AUDIT',
  'ts.auditReview': 'REVIEW',
  'ts.error': 'ERROR',
  'ts.unnamed': 'unnamed',
}
const tt = (key: string): string => TRACE_LABELS[key] ?? key

describe('fmtTokens', () => {
  test('compact magnitudes for the badge', () => {
    expect(fmtTokens(900)).toBe('900')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(1_500_000)).toBe('1.5M')
  })
})

describe('traceToThinkingStep', () => {
  const step = (over: Partial<ThinkStep>): ThinkStep =>
    ({ id: 1, ts: 1_700_000_000_000, kind: 'wake', ...over }) as ThinkStep

  test('decide ships the action plan up front — kinds + titles in the detail', () => {
    const s = traceToThinkingStep(
      step({ kind: 'decide', tokens: 340, actions: [
        { type: 'spawn', title: `整理下载文件夹 ${'归'.repeat(70)}` },
        { type: 'reply', title: '晚上好' },
      ] }),
      tt,
    )
    expect(s.kind).toBe('decision')
    expect(s.label).toBe('PLAN 2')
    expect(s.tokens).toBe(340)
    // titles over 60 chars are clipped with an ellipsis; short ones verbatim
    const clip = (s: string): string => `${s.slice(0, 60)}${s.length > 60 ? '…' : ''}`
    expect(s.detail).toContain(`spawn(${clip(`整理下载文件夹 ${'归'.repeat(70)}`)})`)
    expect(s.detail).toContain('reply(晚上好)')
  })

  test('spawn_done maps to the done visual and honors the outcome', () => {
    const ok = traceToThinkingStep(step({ kind: 'spawn_done', ok: true, title: '清理磁盘' }), tt)
    expect(ok.kind).toBe('done')
    expect(ok.label).toBe('OK — 清理磁盘')
    const fail = traceToThinkingStep(step({ kind: 'spawn_done', ok: false, title: '清理磁盘' }), tt)
    expect(fail.label).toBe('FAIL — 清理磁盘')
  })

  test('wake/patrol/audit kinds carry tokens, wake and task ids through', () => {
    const p = traceToThinkingStep(
      step({ kind: 'patrol', verdict: 'act', tokens: 42, wake: 7, taskId: 'ab12cd34' }),
      tt,
    )
    expect(p.label).toBe('PATROL act · 42')
    expect(p.tokens).toBe(42)
    expect(p.wake).toBe(7)
    expect(p.taskIds).toEqual(['ab12cd34'])
    expect(traceToThinkingStep(step({ kind: 'audit', tokens: 100 }), tt).label).toBe('AUDIT')
  })

  test('unknown kinds from a newer core still render (never dropped)', () => {
    const s = traceToThinkingStep(step({ kind: 'heartbeat_note', detail: 'kept alive' }), tt)
    expect(s.label).toContain('heartbeat_note')
    expect(s.label).toContain('kept alive')
  })

  test('both dictionaries carry a label for every shipped trace kind', () => {
    for (const dict of [zh, en]) {
      for (const k of ['wake', 'patrolVerdict', 'decisionPlan', 'spawn', 'doneOk', 'doneFail', 'audit', 'auditReview', 'error', 'wakeGroup', 'live', 'stepN']) {
        expect(dict[`ts.${k}`], `ts.${k}`).toBeTruthy()
      }
    }
  })
})
