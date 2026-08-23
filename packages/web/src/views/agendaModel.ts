// packages/web/src/views/agendaModel.ts — pure agenda math: percent placement
// of task blocks inside a 24h day, the unscheduled side list, the 7-day column
// split, zoom-level hour resolution, drag-to-reschedule math, and overdue/upcoming detection.

import type { Task } from '../state/types'
import { DAY_MS, dayStartOf } from './timefmt'

export const MIN_BLOCK_MS = 30 * 60_000

/** One hour in ms. */
export const HOUR_MS = 3_600_000

/** Hour-row height at the 24h zoom level; deeper zooms scale it up. */
export const BASE_HOUR_H = 56

/**
 * N local days after `day0` (a local midnight), landing on local midnight
 * again. Plain `day0 + n * DAY_MS` drifts across DST transitions (a fall-back
 * day is 25h), which would duplicate or skip a column; anchoring on
 * `dayStartOf` keeps every column a real midnight. In fixed-offset zones this
 * is exactly `day0 + n * DAY_MS`.
 */
export function addDaysLocal(day0: number, n: number): number {
  // +12h lands mid-day even under a ±1h DST shift, so dayStartOf picks the
  // intended calendar day rather than the one before it.
  return dayStartOf(day0 + n * DAY_MS + 12 * HOUR_MS)
}

export interface AgendaBlock {
  task: Task
  topPct: number
  heightPct: number
  /** dueAt reaches past the rendered day — Days view draws a continuation. */
  spansBeyond: boolean
  /** Task is past its dueAt. */
  isOverdue: boolean
  /** Task is due within 1 hour from `now`. */
  isUpcoming: boolean
  /** Depth in the task tree (0 = root). */
  treeDepth: number
  /** Child tasks of this block's task, for tree grouping. */
  childBlocks: AgendaBlock[]
}

/** Build a parent→children map for tree grouping. */
function buildParentMap(tasks: Task[]): Map<string | null | undefined, Task[]> {
  const map = new Map<string | null | undefined, Task[]>()
  for (const t of tasks) {
    const key = t.parentId ?? null
    const arr = map.get(key) ?? []
    arr.push(t)
    map.set(key, arr)
  }
  return map
}

/** Compute tree depth for a task (0 = root). Parent chains that cycle are cut
 * at the first repeat so malformed data cannot recurse forever. */
function treeDepth(task: Task, byId: Map<string, Task>, cache: Map<string, number>): number {
  const cached = cache.get(task.id)
  if (cached !== undefined) return cached
  let depth = 0
  if (task.parentId && task.parentId !== task.id) {
    const seen = new Set<string>([task.id])
    let cur = byId.get(task.parentId)
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      depth += 1
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  cache.set(task.id, depth)
  return depth
}

/** Blocks for tasks whose scheduledAt falls inside the day [day0, next midnight).
 * A task scheduled inside the day renders exactly once: nested under its
 * in-day parent when one exists (any depth), otherwise as a top-level block.
 * Cycle members whose whole ancestry is in-day surface as roots so no task
 * silently vanishes. */
export function blocksForDay(tasks: Task[], day0: number, now: number): AgendaBlock[] {
  const end = addDaysLocal(day0, 1)
  const parentMap = buildParentMap(tasks)
  const byId = new Map(tasks.map((t) => [t.id, t] as const))
  const depthCache = new Map<string, number>()
  const out: AgendaBlock[] = []

  const inDay = (ms: number | null | undefined): ms is number =>
    ms != null && ms >= day0 && ms < end

  /** True when some ancestor is scheduled in-day — the task will be rendered
   * inside that ancestor's block. Ancestry cycles (a↔b) would make every
   * member "nested" under another skipped task, so they surface as roots. */
  const nestedInDay = (t: Task): boolean => {
    const seen = new Set<string>([t.id])
    let cur = t.parentId ? byId.get(t.parentId) : undefined
    while (cur) {
      if (seen.has(cur.id)) return false // cycle — surface as a root instead
      seen.add(cur.id)
      if (inDay(cur.scheduledAt)) return true
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return false
  }

  const makeBlock = (t: Task, depth: number): AgendaBlock => {
    const s = t.scheduledAt!
    const due = t.dueAt
    const stop = due != null && due > s ? Math.min(due, end) : s + MIN_BLOCK_MS
    const block: AgendaBlock = {
      task: t,
      topPct: ((s - day0) / DAY_MS) * 100,
      heightPct: (Math.max(MIN_BLOCK_MS, stop - s) / DAY_MS) * 100,
      spansBeyond: due != null && due > end,
      isOverdue: due != null && due < now && t.status !== 'done',
      isUpcoming: due != null && due >= now && due - now <= HOUR_MS && t.status !== 'done',
      treeDepth: depth,
      childBlocks: [],
    }
    for (const c of parentMap.get(t.id) ?? []) {
      if (c.status === 'cancelled') continue
      if (inDay(c.scheduledAt)) block.childBlocks.push(makeBlock(c, depth + 1))
    }
    return block
  }

  for (const t of tasks) {
    if (t.status === 'cancelled') continue // zombie blocks intercept drags/clicks of live cards
    if (!inDay(t.scheduledAt)) continue
    if (nestedInDay(t)) continue // rendered inside an ancestor's block
    out.push(makeBlock(t, treeDepth(t, byId, depthCache)))
  }
  return out.sort((a, b) => a.topPct - b.topPct)
}

/** Tasks with no scheduledAt — the Day view's "no time" side list. */
export function unscheduledTasks(tasks: Task[]): Task[] {
  return tasks
    // done needs no slot and cancelled is dead — the rail is a to-place list
    .filter((t) => t.scheduledAt == null && t.status !== 'cancelled' && t.status !== 'done')
    .sort((a, b) => a.createdAt - b.createdAt)
}

export interface DayColumn {
  day0: number
  blocks: AgendaBlock[]
  today: boolean
}

/** `count` consecutive day columns starting at `from0` (a local midnight). */
export function dayColumns(tasks: Task[], from0: number, now: number, count = 7): DayColumn[] {
  const today0 = dayStartOf(now)
  return Array.from({ length: count }, (_, i) => {
    const day0 = addDaysLocal(from0, i)
    return { day0, blocks: blocksForDay(tasks, day0, now), today: day0 === today0 }
  })
}

/** Now-line position inside a day as percent, or null when `now` is outside. */
export function nowPct(day0: number, now: number): number | null {
  if (now < day0 || now >= addDaysLocal(day0, 1)) return null
  return ((now - day0) / DAY_MS) * 100
}

// ---- Zoom ----

/** Supported zoom levels: hours shown per screen-height. The 1h and 0.5h
 * levels unlock minute-grid resolution (5-min snap + minute tick marks). */
export const ZOOM_LEVELS = [24, 12, 6, 3, 1, 0.5] as const
export type ZoomLevel = (typeof ZOOM_LEVELS)[number]

/** Clamp zoom index. */
export function clampZoom(idx: number): number {
  return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx))
}

/** Hour row height for a given zoom level (24h → 56px, 3h → 448px). */
export function hourHeight(zoom: ZoomLevel): number {
  return (24 / zoom) * BASE_HOUR_H
}

// ---- Drag-to-reschedule ----

/** Convert a pointer Y position (relative to the full 24h track, i.e. including
 * scrollTop) to epoch ms. `viewportHeight` is the visible window's height in
 * px — the zoom level's worth of hour rows, NOT the whole 24h track. */
export function yToTime(
  y: number,
  viewportHeight: number,
  day0: number,
  zoom: ZoomLevel,
  scrollHours: number,
): number {
  const pxPerHour = viewportHeight / zoom
  const hour = scrollHours + y / pxPerHour
  return day0 + hour * HOUR_MS
}

/** Snap epoch ms to the nearest `minutes`-minute boundary. */
export function snapTo(ms: number, minutes: number): number {
  return Math.round(ms / (minutes * 60_000)) * (minutes * 60_000)
}

/** Snap granularity for a zoom level: ≤1h → 5-min, else 15-min. */
export function snapMinutes(zoom: ZoomLevel): number {
  return zoom <= 1 ? 5 : 15
}

/** Snap epoch ms to nearest 15-minute boundary. */
export function snapTo15(ms: number): number {
  return snapTo(ms, 15)
}
