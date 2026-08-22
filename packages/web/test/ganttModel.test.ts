// packages/web/test/ganttModel.test.ts — pure geometry tests for the Command
// Center gantt board: lane mapping, the 7-day window, task→[start,end,width]
// percent mapping (clamping, min-bar, out-of-window) and grouping.
import { describe, expect, test } from 'vitest'
import {
  GANTT_DAYS,
  LANES,
  MIN_BAR_MS,
  barGeom,
  fmtRel,
  ganttWindow,
  groupForGantt,
  laneOf,
} from '../src/views/ganttModel'
import { DAY_MS, dayStartOf } from '../src/views/timefmt'
import type { Task } from '../src/state/types'

let n = 0
const T = (over: Partial<Task> = {}): Task => ({
  id: over.id ?? `t${++n}`,
  title: over.title ?? `task ${n}`,
  status: over.status ?? 'todo',
  resultSummary: over.resultSummary ?? '',
  createdAt: over.createdAt ?? 1_000 + n,
  parentId: over.parentId ?? null,
  scheduledAt: over.scheduledAt ?? null,
  dueAt: over.dueAt ?? null,
})

// fixed anchor: local midnight of a known day
const NOW = new Date(2026, 7, 20, 9, 30).getTime()
const T0 = dayStartOf(NOW)
const WIN = ganttWindow(NOW)
const SPAN = WIN.end - WIN.start

describe('laneOf', () => {
  test('core statuses map to their lanes', () => {
    expect(laneOf('todo')).toBe('todo')
    expect(laneOf('running')).toBe('running')
    expect(laneOf('done')).toBe('done')
    expect(laneOf('blocked')).toBe('blocked')
  })

  test('loose statuses fold into the same vocabulary as statusTone', () => {
    expect(laneOf('COMPLETED')).toBe('done')
    expect(laneOf('in-progress')).toBe('running')
    expect(laneOf('failed')).toBe('blocked')
    expect(laneOf('weird')).toBe('todo')
  })
})

describe('ganttWindow', () => {
  test('anchors at today’s local midnight and spans GANTT_DAYS days', () => {
    expect(WIN.start).toBe(T0)
    expect(WIN.end).toBe(T0 + GANTT_DAYS * DAY_MS)
    expect(WIN.days).toBe(GANTT_DAYS)
    expect(SPAN).toBe(7 * DAY_MS)
  })
})

describe('barGeom', () => {
  test('maps scheduledAt→dueAt onto exact percents', () => {
    const bar = barGeom(T({ scheduledAt: T0 + DAY_MS, dueAt: T0 + 2 * DAY_MS }), WIN)!
    expect(bar.startPct).toBeCloseTo((1 / 7) * 100, 10)
    expect(bar.endPct).toBeCloseTo((2 / 7) * 100, 10)
    expect(bar.widthPct).toBeCloseTo((1 / 7) * 100, 10)
  })

  test('single-date task grows to the MIN_BAR_MS minimum width', () => {
    const at = T0 + 3 * DAY_MS
    const bar = barGeom(T({ scheduledAt: at }), WIN)!
    expect(bar.startPct).toBeCloseTo((3 / 7) * 100, 10)
    expect(bar.widthPct).toBeCloseTo((MIN_BAR_MS / SPAN) * 100, 10)
    // dueAt-only: the bar ENDS on the deadline, extending backward
    const due = barGeom(T({ dueAt: at }), WIN)!
    expect(due.endPct).toBeCloseTo((3 / 7) * 100, 10)
    expect(due.startPct).toBeCloseTo((3 / 7) * 100 - (MIN_BAR_MS / SPAN) * 100, 10)
  })

  test('overdue work clamps to a left-edge sliver', () => {
    const bar = barGeom(T({ scheduledAt: T0 - 2 * DAY_MS, dueAt: T0 - DAY_MS }), WIN)!
    expect(bar.startPct).toBe(0)
    expect(bar.widthPct).toBeCloseTo((MIN_BAR_MS / SPAN) * 100, 10)
  })

  test('due beyond the window clamps the right edge at 100%', () => {
    const bar = barGeom(T({ scheduledAt: T0 + 6 * DAY_MS, dueAt: T0 + 30 * DAY_MS }), WIN)!
    expect(bar.endPct).toBe(100)
    expect(bar.widthPct).toBeCloseTo(100 - (6 / 7) * 100, 10)
  })

  test('starts after the window → null (beyond the visible week)', () => {
    expect(barGeom(T({ scheduledAt: T0 + 8 * DAY_MS, dueAt: T0 + 9 * DAY_MS }), WIN)).toBeNull()
  })

  test('undated task → null (belongs to the unscheduled zone)', () => {
    expect(barGeom(T(), WIN)).toBeNull()
  })
})

describe('groupForGantt', () => {
  test('every lane is present in LANES order, membership by status', () => {
    const g = groupForGantt(
      [
        T({ id: 'a', status: 'todo' }),
        T({ id: 'b', status: 'running' }),
        T({ id: 'c', status: 'blocked' }),
        T({ id: 'd', status: 'done' }),
      ],
      WIN,
    )
    expect(g.lanes.map((l) => l.lane)).toEqual(LANES)
    expect(g.lanes.map((l) => l.tasks.map((t) => t.id))).toEqual([['a'], ['b'], ['c'], ['d']])
  })

  test('undated tasks land in unscheduled (newest first), dated never do', () => {
    const g = groupForGantt(
      [
        T({ id: 'u1', createdAt: 100 }),
        T({ id: 'u2', createdAt: 300 }),
        T({ id: 'u3', createdAt: 200 }),
        // dated but beyond the week: not scheduled, and not unscheduled either
        T({ id: 'far', scheduledAt: T0 + 10 * DAY_MS, dueAt: T0 + 11 * DAY_MS }),
      ],
      WIN,
    )
    expect(g.unscheduled.map((t) => t.id)).toEqual(['u2', 'u3', 'u1'])
    expect(g.scheduled.map((s) => s.task.id)).toEqual([])
  })

  test('scheduled rows sort by start percent, then createdAt', () => {
    const g = groupForGantt(
      [
        T({ id: 'late', scheduledAt: T0 + 3 * DAY_MS, createdAt: 1 }),
        T({ id: 'early', scheduledAt: T0 + DAY_MS, createdAt: 9 }),
        T({ id: 'tie', scheduledAt: T0 + DAY_MS, createdAt: 5 }),
      ],
      WIN,
    )
    expect(g.scheduled.map((s) => s.task.id)).toEqual(['tie', 'early', 'late'])
  })
})

describe('fmtRel', () => {
  test('null for missing, 刚刚 for sub-minute, suffix 前 for the past', () => {
    expect(fmtRel(null, NOW)).toBeNull()
    expect(fmtRel(NOW + 20_000, NOW)).toBe('刚刚')
    expect(fmtRel(NOW - 90 * 60_000, NOW)).toBe('1.5h前')
    expect(fmtRel(NOW + 3 * 3_600_000, NOW)).toBe('3h')
    expect(fmtRel(NOW - 2 * DAY_MS, NOW)).toBe('2d前')
  })
})
