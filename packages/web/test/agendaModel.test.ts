// packages/web/test/agendaModel.test.ts — pure placement tests for the Agenda
// view (percent math, 30-min default, cross-day continuation, day columns,
// task-tree nesting).
import { describe, expect, test } from 'vitest'
import {
  MIN_BLOCK_MS,
  addDaysLocal,
  blocksForDay,
  dayColumns,
  nowPct,
  unscheduledTasks,
} from '../src/views/agendaModel'
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

const DAY0 = dayStartOf(Date.now())
const at = (hours: number, min = 0): number => DAY0 + hours * 3_600_000 + min * 60_000

describe('blocksForDay', () => {
  test('percent top/height; no due defaults to 30 minutes', () => {
    const [b] = blocksForDay([T({ scheduledAt: at(9) })], DAY0)
    expect(b).toBeDefined()
    expect(b!.topPct).toBeCloseTo((9 / 24) * 100)
    expect(b!.heightPct).toBeCloseTo((MIN_BLOCK_MS / DAY_MS) * 100)
    expect(b!.spansBeyond).toBe(false)
  })

  test('height spans sched→due and floors at 30 minutes', () => {
    const [long] = blocksForDay([T({ scheduledAt: at(9), dueAt: at(11, 30) })], DAY0)
    expect(long!.heightPct).toBeCloseTo((2.5 * 3_600_000 / DAY_MS) * 100)
    const [short] = blocksForDay([T({ scheduledAt: at(9), dueAt: at(9, 10) })], DAY0)
    expect(short!.heightPct).toBeCloseTo((MIN_BLOCK_MS / DAY_MS) * 100)
  })

  test('only tasks scheduled inside the day; sorted by time', () => {
    const blocks = blocksForDay(
      [
        T({ scheduledAt: at(14), title: 'afternoon' }),
        T({ scheduledAt: DAY0 - 1, title: 'yesterday' }),
        T({ scheduledAt: DAY0 + DAY_MS, title: 'tomorrow' }),
        T({ scheduledAt: null, title: 'unscheduled' }),
        T({ scheduledAt: at(8), title: 'morning' }),
      ],
      DAY0,
    )
    expect(blocks.map((b) => b.task.title)).toEqual(['morning', 'afternoon'])
  })

  test('cross-day task flags spansBeyond and clamps height to day end', () => {
    const [b] = blocksForDay([T({ scheduledAt: at(23), dueAt: at(25) })], DAY0)
    expect(b!.spansBeyond).toBe(true)
    expect(b!.heightPct).toBeCloseTo((1 * 3_600_000 / DAY_MS) * 100) // 23:00→24:00
  })
})

describe('unscheduledTasks', () => {
  test('collects schedAt=null, ordered by createdAt', () => {
    const out = unscheduledTasks([
      T({ createdAt: 30, title: 'later' }),
      T({ createdAt: 10, title: 'first' }),
      T({ scheduledAt: at(9), title: 'timed' }),
    ])
    expect(out.map((t) => t.title)).toEqual(['first', 'later'])
  })
})

describe('dayColumns', () => {
  test('seven consecutive days, today flagged, blocks per column', () => {
    const cols = dayColumns([T({ scheduledAt: at(9), dueAt: at(10) }), T({ scheduledAt: at(9) + DAY_MS })], DAY0, DAY0 + 12 * 3_600_000)
    expect(cols).toHaveLength(7)
    expect(cols.map((c) => c.day0)).toEqual(Array.from({ length: 7 }, (_, i) => DAY0 + i * DAY_MS))
    expect(cols.filter((c) => c.today).map((c) => c.day0)).toEqual([DAY0])
    expect(cols[0]!.blocks).toHaveLength(1)
    expect(cols[1]!.blocks).toHaveLength(1)
    expect(cols[2]!.blocks).toHaveLength(0)
  })
})

describe('nowPct', () => {
  test('fraction inside the day, null outside', () => {
    expect(nowPct(DAY0, DAY0 + 7.2 * 3_600_000)).toBeCloseTo(30)
    expect(nowPct(DAY0, DAY0 - 1)).toBeNull()
    expect(nowPct(DAY0, DAY0 + DAY_MS)).toBeNull()
  })
})
