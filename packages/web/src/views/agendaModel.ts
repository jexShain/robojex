// packages/web/src/views/agendaModel.ts — pure agenda math: percent placement
// of task blocks inside a 24h day, the unscheduled side list, the 7-day column
// split, zoom-level hour resolution, drag-to-reschedule math, and overdue/upcoming detection.

import type { Task } from '../state/types'
import { DAY_MS, dayStartOf } from './timefmt'

export const MIN_BLOCK_MS = 30 * 60_000

/** One hour in ms. */
export const HOUR_MS = 3_600_000

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

/** Compute tree depth for a task. */
function treeDepth(task: Task, parentMap: Map<string | null | undefined, Task[]>, cache: Map<string, number>): number {
  const cached = cache.get(task.id)
  if (cached !== undefined) return cached
  if (!task.parentId) { cache.set(task.id, 0); return 0 }
  const siblings = parentMap.get(null)
  const parent = siblings?.find(s => s.id === task.parentId)
  if (!parent) { cache.set(task.id, 0); return 0 }
  const depth = treeDepth(parent, parentMap, cache) + 1
  cache.set(task.id, depth)
  return depth
}

/** Blocks for tasks whose scheduledAt falls inside the day [day0, day0+24h). */
export function blocksForDay(tasks: Task[], day0: number, now: number): AgendaBlock[] {
  const end = day0 + DAY_MS
  const parentMap = buildParentMap(tasks)
  const depthCache = new Map<string, number>()
  const out: AgendaBlock[] = []
  const ONE_HOUR = HOUR_MS

  for (const t of tasks) {
    const s = t.scheduledAt
    if (s == null || s < day0 || s >= end) continue
    const due = t.dueAt
    const stop = due != null && due > s ? Math.min(due, end) : s + MIN_BLOCK_MS
    const depth = treeDepth(t, parentMap, depthCache)
    const block: AgendaBlock = {
      task: t,
      topPct: ((s - day0) / DAY_MS) * 100,
      heightPct: (Math.max(MIN_BLOCK_MS, stop - s) / DAY_MS) * 100,
      spansBeyond: due != null && due > end,
      isOverdue: due != null && due < now && t.status !== 'done',
      isUpcoming: due != null && due >= now && due - now <= ONE_HOUR && t.status !== 'done',
      treeDepth: depth,
      childBlocks: [],
    }
    // Attach child blocks
    const children = parentMap.get(t.id) ?? []
    for (const c of children) {
      const cs = c.scheduledAt
      if (cs == null || cs < day0 || cs >= end) continue
      const cDue = c.dueAt
      const cStop = cDue != null && cDue > cs ? Math.min(cDue, end) : cs + MIN_BLOCK_MS
      block.childBlocks.push({
        task: c, topPct: ((cs - day0) / DAY_MS) * 100,
        heightPct: (Math.max(MIN_BLOCK_MS, cStop - cs) / DAY_MS) * 100,
        spansBeyond: cDue != null && cDue > end,
        isOverdue: cDue != null && cDue < now && c.status !== 'done',
        isUpcoming: cDue != null && cDue >= now && cDue - now <= ONE_HOUR && c.status !== 'done',
        treeDepth: depth + 1,
        childBlocks: [],
      })
    }
    out.push(block)
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
export function dayColumns(tasks: Task[], from0: number, now: number, count = 7): DayColumn[] {
  const today0 = dayStartOf(now)
  return Array.from({ length: count }, (_, i) => {
    const day0 = from0 + i * DAY_MS
    return { day0, blocks: blocksForDay(tasks, day0, now), today: day0 === today0 }
  })
}

/** Now-line position inside a day as percent, or null when `now` is outside. */
export function nowPct(day0: number, now: number): number | null {
  if (now < day0 || now >= day0 + DAY_MS) return null
  return ((now - day0) / DAY_MS) * 100
}

// ---- Zoom ----

/** Supported zoom levels: hours shown per screen-height. */
export const ZOOM_LEVELS = [24, 12, 6, 3] as const
export type ZoomLevel = (typeof ZOOM_LEVELS)[number]

/** Clamp zoom index. */
export function clampZoom(idx: number): number {
  return Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx))
}

/** Hour row height for a given zoom level. */
export function hourHeight(zoom: ZoomLevel): number {
  // 24h → 56px, 12h → 112px, 6h → 224px, 3h → 448px
  return (24 / zoom) * 56
}

/** Visible time range for a zoom level + scroll offset (in hours). */
export function visibleRange(zoom: ZoomLevel, scrollHours: number): { startH: number; endH: number } {
  return { startH: scrollHours, endH: scrollHours + zoom }
}

// ---- Drag-to-reschedule ----

/** Convert a pointer Y position (relative to the track) to epoch ms, given zoom/scroll context. */
export function yToTime(
  y: number,
  trackHeight: number,
  day0: number,
  zoom: ZoomLevel,
  scrollHours: number,
): number {
  const pxPerHour = trackHeight / zoom
  const hour = scrollHours + y / pxPerHour
  return day0 + hour * HOUR_MS
}

/** Snap epoch ms to nearest 15-minute boundary. */
export function snapTo15(ms: number): number {
  return Math.round(ms / (15 * 60_000)) * (15 * 60_000)
}
