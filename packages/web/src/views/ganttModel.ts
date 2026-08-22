// packages/web/src/views/ganttModel.ts — pure gantt math for the Command
// Center board (SPEC-BUTLER §7): status swimlane grouping, the 7-day time
// window anchored at today's local midnight, and the task→[start,end,width]
// percent mapping for the time band. Deterministic functions of (tasks, now)
// so the geometry is unit-tested directly (test/ganttModel.test.ts).

import type { Task } from '../state/types'
import type { Lang } from '../i18n/event'
import { DAY_MS, dayStartOf } from './timefmt'

/** Time-band span: today plus six more days. */
export const GANTT_DAYS = 7
/** Minimum bar length when a task carries only one date (scheduledAt xor
 * dueAt) — keeps single-date tasks visible on the 7-day scale. */
export const MIN_BAR_MS = 3 * 3_600_000

export type Lane = 'todo' | 'running' | 'blocked' | 'done'

/** Fixed swimlane order (done last — collapsible). */
export const LANES: Lane[] = ['todo', 'running', 'blocked', 'done']

export interface GanttWindow {
  start: number
  end: number
  days: number
}

export interface GanttBar {
  /** left edge, percent of the band width */
  startPct: number
  /** right edge, percent */
  endPct: number
  widthPct: number
}

export interface ScheduledBar {
  task: Task
  bar: GanttBar
}

export interface GanttGroup {
  /** dated tasks inside the visible window, by start then createdAt */
  scheduled: ScheduledBar[]
  /** tasks without scheduledAt/dueAt — the「未排程」zone */
  unscheduled: Task[]
  /** every lane always present (empty ones included), in LANES order */
  lanes: { lane: Lane; tasks: Task[] }[]
}

/** Map a raw status string onto a swimlane. Core statuses are exactly
 * todo/running/done/blocked; the loose matching mirrors store.statusTone. */
export function laneOf(status: string): Lane {
  const s = status.toLowerCase()
  if (s.includes('done') || s.includes('complete') || s.includes('success')) return 'done'
  if (s.includes('run') || s.includes('progress') || s.includes('active')) return 'running'
  if (
    s.includes('fail') ||
    s.includes('error') ||
    s.includes('abort') ||
    s.includes('cancel') ||
    s.includes('block')
  )
    return 'blocked'
  return 'todo'
}

/** Window from today's local midnight spanning `days` days. */
export function ganttWindow(now: number, days = GANTT_DAYS): GanttWindow {
  const start = dayStartOf(now)
  return { start, end: start + days * DAY_MS, days }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Map one task onto the window as {startPct, endPct, widthPct}. Rules:
 *  - undated task → null (it lands in the unscheduled zone instead)
 *  - starts after the window → null (beyond the visible week; the swimlanes
 *    still carry it)
 *  - edges clamp to [0,100]: overdue work stays pinned at the left border
 *  - a single date grows to MIN_BAR_MS so the bar stays visible — the bar
 *    extends forward from a lone scheduledAt and ends on a lone dueAt */
export function barGeom(task: Task, win: GanttWindow): GanttBar | null {
  if (task.scheduledAt == null && task.dueAt == null) return null
  const rawStart = task.scheduledAt ?? task.dueAt! - MIN_BAR_MS
  const rawEnd = task.dueAt ?? rawStart + MIN_BAR_MS
  if (rawStart >= win.end) return null
  const span = win.end - win.start
  const p = (ms: number): number => clamp(((ms - win.start) / span) * 100, 0, 100)
  const startPct = p(rawStart)
  const endPct = Math.min(Math.max(p(rawEnd), startPct + (MIN_BAR_MS / span) * 100), 100)
  return { startPct, endPct, widthPct: endPct - startPct }
}

/** Split the board: dated tasks → band rows (by start), undated → the
 * unscheduled zone, everyone → their status swimlane. */
export function groupForGantt(tasks: Task[], win: GanttWindow): GanttGroup {
  const scheduled: ScheduledBar[] = []
  const unscheduled: Task[] = []
  const laneMap = new Map<Lane, Task[]>(LANES.map((l) => [l, []]))
  for (const t of tasks) {
    laneMap.get(laneOf(t.status))!.push(t)
    const bar = barGeom(t, win)
    if (bar) scheduled.push({ task: t, bar })
    else if (t.scheduledAt == null && t.dueAt == null) unscheduled.push(t)
  }
  scheduled.sort((a, b) => a.bar.startPct - b.bar.startPct || a.task.createdAt - b.task.createdAt)
  unscheduled.sort((a, b) => b.createdAt - a.createdAt)
  return { scheduled, unscheduled, lanes: LANES.map((lane) => ({ lane, tasks: laneMap.get(lane)! })) }
}

/** Compact relative time for card corners: `3h` future / `2h前` (zh) or
 * `2h ago` (en); null for missing dates (callers fall back to creation age). */
export function fmtRel(ms: number | null | undefined, now: number, lang: Lang = 'zh'): string | null {
  if (ms == null) return null
  const diff = ms - now
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  let core: string
  if (mins < 1) return lang === 'en' ? 'now' : '刚刚'
  if (mins < 60) core = `${mins}m`
  else if (abs < DAY_MS) {
    // one decimal under 10h (1.5h), integers beyond (14h) — no trailing .0
    const h = abs / 3_600_000
    core = `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)}h`
  } else core = `${Math.round(abs / DAY_MS)}d`
  if (diff >= 0) return core
  return lang === 'en' ? `${core} ago` : `${core}前`
}
