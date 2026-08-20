// packages/web/src/views/agendaModel.ts — pure agenda math: percent placement
// of task blocks inside a 24h day (spec: top = (schedAt - day start) / 86400,
// height = max(30min, dueAt - schedAt), no due → 30min), the unscheduled side
// list, and the 7-day column split with cross-day continuation flags.

import type { Task } from '../state/types'
import { DAY_MS, dayStartOf } from './timefmt'

export const MIN_BLOCK_MS = 30 * 60_000

export interface AgendaBlock {
  task: Task
  topPct: number
  heightPct: number
  /** dueAt reaches past the rendered day — Days view draws a continuation. */
  spansBeyond: boolean
}

/** Blocks for tasks whose scheduledAt falls inside the day [day0, day0+24h). */
export function blocksForDay(tasks: Task[], day0: number): AgendaBlock[] {
  const end = day0 + DAY_MS
  const out: AgendaBlock[] = []
  for (const t of tasks) {
    const s = t.scheduledAt
    if (s == null || s < day0 || s >= end) continue
    const due = t.dueAt
    const stop = due != null && due > s ? Math.min(due, end) : s + MIN_BLOCK_MS
    out.push({
      task: t,
      topPct: ((s - day0) / DAY_MS) * 100,
      heightPct: (Math.max(MIN_BLOCK_MS, stop - s) / DAY_MS) * 100,
      spansBeyond: due != null && due > end,
    })
  }
  return out.sort((a, b) => a.topPct - b.topPct)
}

/** Tasks with no scheduledAt — the Day view's "no time" side list. */
export function unscheduledTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((t) => t.scheduledAt == null)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export interface DayColumn {
  day0: number
  blocks: AgendaBlock[]
  today: boolean
}

/** `count` consecutive day columns starting at `from0` (a local midnight). */
export function dayColumns(tasks: Task[], from0: number, count = 7): DayColumn[] {
  const today0 = dayStartOf(Date.now())
  return Array.from({ length: count }, (_, i) => {
    const day0 = from0 + i * DAY_MS
    return { day0, blocks: blocksForDay(tasks, day0), today: day0 === today0 }
  })
}

/** Now-line position inside a day as percent, or null when `now` is outside. */
export function nowPct(day0: number, now: number): number | null {
  if (now < day0 || now >= day0 + DAY_MS) return null
  return ((now - day0) / DAY_MS) * 100
}
