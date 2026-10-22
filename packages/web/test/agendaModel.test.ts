// packages/web/test/agendaModel.test.ts — pure placement tests for the Agenda
// view (percent math, 30-min default, cross-day continuation, day columns,
// task-tree nesting).
import { describe, expect, test } from 'vitest'
import {
  MIN_BLOCK_MS,
  ZOOM_LEVELS,
  addDaysLocal,
  blocksForDay,
  clampZoom,
  dayColumns,
  ganttDropTime,
  ganttRows,
  hourHeight,
  minBarPct,
  monthStartOf,
  nowPct,
  nowPctRange,
  pctOf,
  rangeSnapMinutes,
  rangeWindow,
  snapMinutes,
  snapTo,
  snapTo15,
  unscheduledTasks,
  weekStartOf,
  xToTimeRange,
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
  milestone: over.milestone,
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

  // R111: a cancelled card is dead weight that would sit on the calendar
  // intercepting drags and clicks of live blocks underneath (found live by
  // e2e ordering: a cancelled card dragged ON TOP of a fresh one).
  test('overlap packing: cards sharing a moment split lanes, not paint order', () => {
    const a = T({ id: 'a', scheduledAt: at(9), dueAt: at(10) })
    const b = T({ id: 'b', scheduledAt: at(9, 30), dueAt: at(11) })
    const c = T({ id: 'c', scheduledAt: at(10, 30), dueAt: at(12) })
    const blocks = blocksForDay([a, b, c], DAY0)
    const by = (id: string) => blocks.find((x) => x.task.id === id)!
    // one cluster, two lanes; c reuses lane 0 once a ended
    expect(by('a')).toMatchObject({ lane: 0, laneCount: 2 })
    expect(by('b')).toMatchObject({ lane: 1, laneCount: 2 })
    expect(by('c')).toMatchObject({ lane: 0, laneCount: 2 })
    // apart cards keep the whole track
    const solo = blocksForDay([T({ id: 'x', scheduledAt: at(1) }), T({ id: 'y', scheduledAt: at(20) })], DAY0)
    expect(solo.every((x) => x.laneCount === 1)).toBe(true)
  })

  test('cancelled tasks render no blocks — roots, children, and side list', () => {
    const live = T({ id: 'live', scheduledAt: at(10) })
    const dead = T({ id: 'dead', status: 'cancelled', scheduledAt: at(10) })
    const deadKid = T({ id: 'dead-kid', status: 'cancelled', parentId: 'live', scheduledAt: at(10, 30) })
    const blocks = blocksForDay([live, dead, deadKid], DAY0)
    expect(blocks.map((b) => b.task.id)).toEqual(['live'])
    expect(blocks[0]!.childBlocks).toHaveLength(0) // cancelled child filtered too
    expect(unscheduledTasks([T({ id: 'u1' }), T({ id: 'u2', status: 'cancelled' })]).map((t) => t.id)).toEqual(['u1'])
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

describe('ZOOM_LEVELS', () => {
  test('includes 1h and 0.5h minute-resolution levels', () => {
    expect(ZOOM_LEVELS).toEqual([24, 12, 6, 3, 1, 0.5])
    expect(ZOOM_LEVELS).toContain(1)
    expect(ZOOM_LEVELS).toContain(0.5)
  })
})

describe('hourHeight', () => {
  test('scales inversely with zoom; 0.5h doubles the 1h height', () => {
    const h1 = hourHeight(1)
    const hHalf = hourHeight(0.5)
    const h24 = hourHeight(24)
    expect(h24).toBe(56) // BASE_HOUR_H at the widest level
    expect(h1).toBe(24 * 56) // 1344
    expect(hHalf).toBe(2 * h1) // 2688 — 0.5h is twice as tall per hour
  })
})

describe('snapMinutes', () => {
  test('≤1h zoom → 5-min, else 15-min', () => {
    expect(snapMinutes(0.5)).toBe(5)
    expect(snapMinutes(1)).toBe(5)
    expect(snapMinutes(3)).toBe(15)
    expect(snapMinutes(24)).toBe(15)
  })
})

describe('snapTo', () => {
  test('rounds to nearest N-minute boundary', () => {
    const noon = DAY0 + 12 * 3_600_000
    expect(snapTo(noon, 5)).toBe(noon)
    expect(snapTo(noon + 2 * 60_000, 5)).toBe(noon) // 12:02 → 12:00
    expect(snapTo(noon + 3 * 60_000, 5)).toBe(noon + 5 * 60_000) // 12:03 → 12:05
    expect(snapTo(noon + 8 * 60_000, 15)).toBe(noon + 15 * 60_000) // 12:08 → 12:15
  })

  test('snapTo15 delegates to snapTo(ms, 15)', () => {
    const t = DAY0 + 12 * 3_600_000 + 7 * 60_000
    expect(snapTo15(t)).toBe(snapTo(t, 15))
  })
})

describe('blocksForDay at 0.5h zoom', () => {
  test('heightPct is zoom-independent; 0.5h placement math unchanged', () => {
    // blocksForDay uses percent math (ms / DAY_MS), independent of zoom.
    // A 30-min block at 09:00 is the same percent regardless of zoom level.
    const [b] = blocksForDay([T({ scheduledAt: at(9) })], DAY0)
    expect(b).toBeDefined()
    expect(b!.topPct).toBeCloseTo((9 / 24) * 100)
    expect(b!.heightPct).toBeCloseTo((MIN_BLOCK_MS / DAY_MS) * 100)
  })
})

describe('clampZoom', () => {
  test('clamps to the 0.5h..24h range via index', () => {
    expect(clampZoom(-1)).toBe(0)
    expect(clampZoom(ZOOM_LEVELS.length)).toBe(ZOOM_LEVELS.length - 1)
    expect(clampZoom(3)).toBe(3)
  })
})

import { overdueRows, scheduleGroups } from "../src/views/agendaModel"

describe("scheduleGroups (R136 list)", () => {
  const NOW = at(10)

  test("one group per day, rows sorted by start; cancelled skipped, done stays (dimmed history)", () => {
    const tasks = [
      T({ id: "a", scheduledAt: at(15) }),
      T({ id: "b", scheduledAt: at(9) }),
      T({ id: "c", scheduledAt: at(9), status: "cancelled" }),
      T({ id: "d", scheduledAt: at(9), status: "done" }),
      T({ id: "e", scheduledAt: addDaysLocal(DAY0, 1) + at(2) - DAY0 }),
    ]
    const groups = scheduleGroups(tasks, DAY0, NOW, 7)
    expect(groups).toHaveLength(7)
    expect(groups[0].rows.map((r) => r.task.id)).toEqual(["b", "d", "a"])
    expect(groups[1].rows.map((r) => r.task.id)).toEqual(["e"])
    expect(groups.slice(2).every((g) => g.rows.length === 0)).toBe(true)
  })

  test("end/spansBeyond/isOverdue flags", () => {
    const tasks = [
      T({ id: "r1", scheduledAt: at(9), dueAt: at(10) }),
      T({ id: "r2", scheduledAt: at(9), dueAt: addDaysLocal(DAY0, 2) }),
      T({ id: "r3", scheduledAt: at(9), dueAt: at(9) - 1 }), // past due, live
    ]
    const [r1, r2, r3] = scheduleGroups(tasks, DAY0, NOW)[0].rows
    expect(r1.end).toBe(at(10))
    expect(r1.spansBeyond).toBe(false)
    expect(r2.spansBeyond).toBe(true)
    expect(r3.isOverdue).toBe(true)
    expect(r1.isOverdue).toBe(false)
  })

  test("overdueRows pins pre-window live cards, done/cancelled excluded", () => {
    const yest = addDaysLocal(DAY0, -1) + 3_600_000
    const tasks = [
      T({ id: "old", scheduledAt: yest }),
      T({ id: "old-done", scheduledAt: yest, status: "done" }),
      T({ id: "old-dead", scheduledAt: yest, status: "cancelled" }),
      T({ id: "in", scheduledAt: at(9) }),
    ]
    const rows = overdueRows(tasks, DAY0, NOW)
    expect(rows.map((r) => r.task.id)).toEqual(["old"])
  })
})

/* ---- T4 Gantt: horizontal range windows, bar geometry, milestones ---- */

describe("gantt range windows", () => {
  test("day window is exactly one local day; walk steps days", () => {
    const w = rangeWindow("day", DAY0 + 13 * 3_600_000)
    expect(w).toEqual({ kind: "day", start: DAY0, end: DAY0 + DAY_MS })
    expect(rangeWindow("day", DAY0, -1).start).toBe(addDaysLocal(DAY0, -1))
  })

  test("week window starts Monday and holds 7 days; walk steps weeks", () => {
    const w = rangeWindow("week", Date.now())
    expect(new Date(w.start).getDay()).toBe(1)
    expect(w.end - w.start).toBe(7 * DAY_MS)
    expect(rangeWindow("week", Date.now(), -1).start).toBe(addDaysLocal(w.start, -7))
    // weekStartOf agrees with the window, and Sunday belongs to the Monday week
    expect(weekStartOf(addDaysLocal(w.start, 6))).toBe(w.start)
  })

  test("month window is the calendar month; walk crosses year bounds by month", () => {
    const jan = new Date(2026, 0, 17, 12).getTime()
    const w = rangeWindow("month", jan)
    expect(new Date(w.start)).toEqual(new Date(2026, 0, 1))
    expect(new Date(w.end)).toEqual(new Date(2026, 1, 1))
    expect(monthStartOf(jan)).toBe(w.start)
    // walking back from January must land on December of the previous year
    const back = rangeWindow("month", jan, -1)
    expect(new Date(back.start)).toEqual(new Date(2025, 11, 1))
    expect(new Date(back.end)).toEqual(new Date(2026, 0, 1))
  })

  test("now-pointer percent: inside clamps to 0..100, outside is null", () => {
    const w = rangeWindow("day", DAY0)
    expect(nowPctRange(at(12), w)).toBeCloseTo(50)
    expect(nowPctRange(at(12) - DAY_MS, w)).toBeNull()
    expect(nowPctRange(at(12) + DAY_MS, w)).toBeNull()
  })
})

describe("ganttRows", () => {
  const W = rangeWindow("day", DAY0)

  test("scheduled→due spans the bar; point task floors at the minimum width", () => {
    const span = ganttRows([T({ id: "a", scheduledAt: at(6), dueAt: at(12) })], W, at(9))[0]!
    expect(span.leftPct).toBeCloseTo(25)
    expect(span.leftPct + span.widthPct).toBeCloseTo(50)
    const point = ganttRows([T({ id: "p", scheduledAt: at(6) })], W, at(9))[0]!
    expect(point.widthPct).toBeCloseTo(minBarPct("day"))
  })

  test("bands outside the window are excluded, cancelled always is", () => {
    const tasks = [
      T({ id: "yest", scheduledAt: DAY0 - 2 * 3_600_000 }),
      T({ id: "in", scheduledAt: at(9) }),
      T({ id: "dead", status: "cancelled", scheduledAt: at(9) }),
      T({ id: "free" }),
    ]
    expect(ganttRows(tasks, W, at(10)).map((r) => r.task.id)).toEqual(["in"])
  })

  test("a band crossing the window clips and flags; rows sort by band start", () => {
    const long = ganttRows([T({ id: "long", scheduledAt: DAY0 - 6 * 3_600_000, dueAt: at(6) })], W, at(10))[0]!
    expect(long.leftPct).toBe(0)
    expect(long.clippedStart).toBe(true)
    expect(long.clippedEnd).toBe(false)
    const byStart = ganttRows([T({ id: "b", scheduledAt: at(15) }), T({ id: "a", scheduledAt: at(9) })], W, at(10))
    expect(byStart.map((r) => r.task.id)).toEqual(["a", "b"])
  })

  test("overdue pulses live cards only; upcoming within the hour", () => {
    const rows = ganttRows(
      [
        T({ id: "late", scheduledAt: at(7), dueAt: at(9), status: "running" }),
        T({ id: "late-done", scheduledAt: at(7), dueAt: at(9), status: "done" }),
        T({ id: "soon", scheduledAt: at(9), dueAt: at(10, 30) }),
      ],
      W,
      at(10),
    )
    const by = (id: string) => rows.find((r) => r.task.id === id)!
    expect(by("late").isOverdue).toBe(true)
    expect(by("late-done").isOverdue).toBe(false)
    expect(by("soon").isUpcoming).toBe(true)
  })

  test("milestone marker rides dueAt (or scheduledAt), clamped; others are null", () => {
    const ms = ganttRows([T({ id: "m", scheduledAt: at(6), dueAt: at(12), milestone: true })], W, at(9))[0]!
    expect(ms.milestonePct).toBeCloseTo(50)
    const plain = ganttRows([T({ id: "p", scheduledAt: at(6) })], W, at(9))[0]!
    expect(plain.milestonePct).toBeNull()
    // a milestone whose dueAt trails past the window edge still marks the edge
    const edge = ganttRows([T({ id: "e", scheduledAt: at(20), dueAt: DAY0 + 2 * DAY_MS, milestone: true })], W, at(9))[0]!
    expect(edge.milestonePct).toBe(100)
  })
})

describe("gantt drag math", () => {
  test("x→time: mid-track is the mid-window, edges clamp into the window", () => {
    const W = rangeWindow("day", DAY0)
    expect(xToTimeRange(50, W)).toBe(at(12))
    expect(xToTimeRange(-20, W)).toBe(W.start)
    expect(xToTimeRange(120, W)).toBe(W.end)
  })

  test("snap granularity per range: 5min day, 30min week, whole days month", () => {
    expect(rangeSnapMinutes("day")).toBe(5)
    expect(rangeSnapMinutes("week")).toBe(30)
    expect(rangeSnapMinutes("month")).toBe(1440)
    expect(snapTo(at(10, 27), rangeSnapMinutes("day"))).toBe(at(10, 25))
  })

  test("month drop keeps the task's time-of-day on the snapped day", () => {
    const orig = at(20) // a 20:00 task
    const target = DAY0 + 3 * DAY_MS + 14 * 3_600_000 // dropped near 14:00 on +3d
    expect(ganttDropTime(target, orig)).toBe(DAY0 + 3 * DAY_MS + 20 * 3_600_000)
  })
})
