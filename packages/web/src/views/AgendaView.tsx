// packages/web/src/views/AgendaView.tsx — calendar on the task board.
// Modes: 日程 (schedule list — chronological, grouped by day; the readable
// default) and 时间轴 (zoomable 24h vertical timeline with drag-to-reschedule,
// hour grid, now-line, overlap lanes — the precision tool).

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { PointerEvent as RPointerEvent, ReactElement } from 'react'
import { statusTone, useStore } from '../state/store'
import { Icon } from '../ui/Icon'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { Task } from '../state/types'
import {
  type AgendaBlock,
  blocksForDay,
  nowPct,
  overdueRows,
  scheduleGroups,
  type ScheduleRow,
  unscheduledTasks,
  ZOOM_LEVELS,
  type ZoomLevel,
  clampZoom,
  hourHeight,
  snapMinutes,
  snapTo,
  yToTime,
} from './agendaModel'
import { dayColHead, dayStartOf, fmtClock, fmtDayLabel, fmtStamp } from './timefmt'
import { addDaysLocal } from './agendaModel'

/** Max tree indentation in px. */
const TREE_INDENT = 20
/** Drag threshold in px before starting a drag. */
const DRAG_THRESHOLD = 4

const toneOf = (t: Task): string => `tone-${statusTone(t.status)}`

/** Fire the reschedule PATCH and manage the in-flight marker; a refused
 *  write reverts the optimistic stage and surfaces the dropped time.
 *  Shared by the day and days modes. */
function sendReschedule(
  id: string,
  newTime: number | null,
  setPending: (update: (m: Map<string, number>) => Map<string, number>) => void,
  setStageErr: (v: string) => void,
): void {
  // null = dropped on the unscheduled rail: the card needs no clock, and
  // there is no slot to badge in-flight — write straight through
  if (newTime === null) {
    void fetch('/api/task', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, scheduledAt: null }),
    })
      .then((r) => { if (!r.ok) throw new Error(`PATCH /api/task -> ${r.status}`); return undefined })
      .catch(() => setStageErr('—'))
    return
  }
  setPending((m) => new Map(m).set(id, newTime))
  void fetch('/api/task', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, scheduledAt: newTime }),
  })
    .then((r) => { if (!r.ok) throw new Error(`PATCH /api/task -> ${r.status}`); return undefined })
    .catch(() => {
      setPending((m) => { const c = new Map(m); c.delete(id); return c })
      setStageErr(new Date(newTime).toLocaleTimeString())
    })
}

/** Retire pending markers the tasks broadcast confirmed (the card now
 *  carries the staged time, or left the board). Returns the same Map
 *  instance when nothing changed so React state can skip the update. */
function retireConfirmed(pending: Map<string, number>, tasks: Task[]): Map<string, number> {
  if (pending.size === 0) return pending
  const next = new Map(pending)
  for (const [id, time] of pending) {
    const t = tasks.find((x) => x.id === id)
    if (t && (t.scheduledAt === time || t.status === 'done' || t.status === 'cancelled')) next.delete(id)
  }
  return next.size === pending.size ? pending : next
}

/** Tooltip text: resultSummary when the task produced one, else the basics. */
function blockTip(t: Task): string {
  if (t.resultSummary) return t.resultSummary
  const s = t.scheduledAt
  const d = t.dueAt
  const range = s != null ? `${fmtClock(s)}${d != null ? `–${fmtClock(d)}` : ''}` : ''
  return range ? `${t.status} · ${range}` : t.status
}

/* A drag that just ended still delivers a click to its pointer-capture
 * element on the same tick — blocks and rail items consult this to ignore
 * that phantom click (observed live: a rail drop opened the detail rail
 * and jumped views). 150ms is generous for one event-loop turn. */
let dragEndedTick = 0
function markDragEnd(): void { dragEndedTick = Date.now() }
function clickAfterDrag(): boolean { return Date.now() - dragEndedTick < 150 }

function AgendaBlockView({
  block,
  now,
  compact,
  pending = false,
  onOpen,
  onDragStart,
}: {
  block: AgendaBlock
  now: number
  compact?: boolean
  /** locally staged reschedule — core has no task-update endpoint yet */
  pending?: boolean
  onOpen(id: string): void
  onDragStart?: (e: PointerEvent, block: AgendaBlock) => void
}) {
  const { t: tr } = useT()
  const t = block.task
  const s = t.scheduledAt
  const d = t.dueAt
  const range = s != null ? `${fmtClock(s)}${d != null ? `–${fmtClock(d)}` : ''}` : ''
  const low = block.topPct < 12
  const indent = block.treeDepth * TREE_INDENT
  const cls = [
    'agenda-block',
    toneOf(t),
    compact ? 'compact' : '',
    low ? 'tip-below' : '',
    block.isOverdue ? 'overdue' : '',
    block.isUpcoming ? 'upcoming' : '',
  ].filter(Boolean).join(' ')
  // overlap packing: a packed block takes a lane slice of the track instead
  // of the full left-10/right-10 strip
  const packed =
    block.laneCount != null && block.laneCount > 1 && block.lane != null
      ? {
          left: `calc(10px + ${(block.lane / block.laneCount).toFixed(4)} * (100% - 20px))`,
          width: `calc(${(1 / block.laneCount).toFixed(4)} * (100% - 20px))`,
          right: 'auto' as const,
        }
      : {}
  return (
    <button
      type="button"
      className={cls}
      style={{ top: `${block.topPct}%`, height: `${block.heightPct}%`, marginLeft: indent, ...packed }}
      data-tip={blockTip(t)}
      title={compact ? `${range} ${t.title}` : undefined}
      onClick={() => { if (!clickAfterDrag()) onOpen(t.id) }}
      onPointerDown={onDragStart ? (e: any) => onDragStart(e.nativeEvent, block) : undefined}
    >
      {!compact ? <span className="ab-time">{range}</span> : null}
      <span className="ab-title">{t.title}</span>
      {pending ? (
        <span className="ab-pend" title={tr('ag.pendingBadge')}>
          <Icon name="clock" size={10} />
        </span>
      ) : null}
      {block.spansBeyond && d != null ? (
        <span className="ab-more">→ {fmtStamp(d, now)}</span>
      ) : null}
    </button>
  )
}

function NowLine({ pct, now }: { pct: number; now: number }) {
  return (
    <div className="agenda-now" style={{ top: `${pct}%` }} aria-hidden="true">
      <span className="an-dot rj-pulse-dot" />
      <span className="an-time">{fmtClock(now)}</span>
    </div>
  )
}

function DayView({ onOpen }: { onOpen(id: string): void }) {
  const { state } = useStore()
  const { t, lang } = useT()
  const [dayOffset, setDayOffset] = useState(0)
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoomIdx, setZoomIdx] = useState(0)
  const [scrollHours, setScrollHours] = useState(0)
  // drag payload: a placed block, or a rail task being dragged in for its
  // first schedule (both only need .task)
  const [dragBlock, setDragBlock] = useState<{ task: Task } | null>(null)
  const [dragY, setDragY] = useState(0)
  const dragStartY = useRef(0)
  const isDragging = useRef(false)

  const zoom = ZOOM_LEVELS[zoomIdx] as ZoomLevel
  const h = hourHeight(zoom)

  // 60s heartbeat advances the now-line.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  // calendar-key navigation: ←/→ walk days, Home returns to today — the way
  // every calendar works. Skipped while a form control holds focus (the
  // time fields own their arrow keys) or mid-drag.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el && el.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); setDayOffset((d) => d - 1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setDayOffset((d) => d + 1) }
      else if (e.key === 'Home') { e.preventDefault(); setDayOffset(0) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const now = Date.now() + state.clockOffset
  const today0 = dayStartOf(now)
  const day0 = addDaysLocal(today0, dayOffset)

  // Drag-reschedule: a drop PATCHes /api/task { id, scheduledAt } and is
  // applied optimistically here; the `pending` map doubles as the in-flight
  // marker (clock badge) until the tasks broadcast confirms the server truth.
  const [pending, setPending] = useState<Map<string, number>>(() => new Map())
  const [stageErr, setStageErr] = useState<string | null>(null)
  useEffect(() => {
    if (stageErr === null) return
    const timer = window.setTimeout(() => setStageErr(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [stageErr])
  const tasks = useMemo(
    () =>
      pending.size === 0
        ? state.tasks
        : state.tasks.map((t) =>
            pending.has(t.id) ? { ...t, scheduledAt: pending.get(t.id) ?? null } : t,
          ),
    [state.tasks, pending],
  )
  const blocks = useMemo(() => blocksForDay(tasks, day0, now), [tasks, day0, now])
  const side = useMemo(() => unscheduledTasks(tasks), [tasks])
  const isToday = dayOffset === 0
  const line = isToday ? nowPct(day0, now) : null

  // Auto-scroll to current hour on today. The scroller is native
  // (.agenda-timeline overflow-y); scrollHours only feeds label
  // virtualization and drop math — BOTH must move together, or the timeline
  // opens at 00:00 with the whole evening below the fold (exactly how a
  // 20:00 task ended up undraggable: the effect used to set state only).
  useEffect(() => {
    if (isToday && scrollRef.current) {
      const currentHour = (now - day0) / 3_600_000
      const targetHours = Math.max(0, currentHour - zoom / 3)
      setScrollHours(targetHours)
      scrollRef.current.scrollTop = targetHours * h
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isToday, zoom, day0])

  // Native scrolls (wheel/trackpad on the container) are the truth — keep
  // scrollHours in sync so drop-time math never drifts from what's on screen.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      if (h > 0) setScrollHours(Math.max(0, el.scrollTop / h))
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [zoom])

  // Wheel: ctrl/⌘ zooms; plain wheel is the container's native scroll (the
  // scroll-sync listener keeps scrollHours truthful — no manual pan here,
  // it used to double-pan with the native scroll).
  const onWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const dir = e.deltaY < 0 ? -1 : 1
      setZoomIdx((i) => clampZoom(i + dir))
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // Drag-to-reschedule handlers (also the drag-in target for rail items).
  const onPointerDown = useCallback((e: PointerEvent, block: AgendaBlock) => {
    dragStartY.current = e.clientY
    isDragging.current = false
    setDragBlock(block)
    setDragY(e.clientY)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])

  // drag FROM the unscheduled rail INTO the timeline = give the card its
  // first slot (the rail's other gesture, click, opens details)
  const onRailDragStart = useCallback((e: PointerEvent, task: Task) => {
    dragStartY.current = e.clientY
    isDragging.current = false
    setDragBlock({ task })
    setDragY(e.clientY)
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragBlock) return
    const dy = Math.abs(e.clientY - dragStartY.current)
    if (!isDragging.current && dy > DRAG_THRESHOLD) isDragging.current = true
    if (isDragging.current) {
      setDragY(e.clientY)
    }
  }, [dragBlock])

  const onPointerUp = useCallback((e: PointerEvent) => {
    if (!dragBlock || !isDragging.current) { setDragBlock(null); return }
    markDragEnd()
    const el = scrollRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      // drop on the unscheduled rail = "this needs no clock": clear the
      // slot (PATCH null) instead of cancelling the gesture — the rail is
      // the natural home for a de-scheduled card
      const onRail =
        document.elementFromPoint(e.clientX, e.clientY)?.closest('.agenda-unsched') != null
      if (onRail) {
        sendReschedule(dragBlock.task.id, null, setPending, setStageErr)
      } else if (e.clientX >= rect.left && e.clientX <= rect.right) {
        // only a drop INSIDE the timeline schedules; dropping elsewhere is a
        // cancelled gesture, not a slot at that y. y is VIEWPORT-relative:
        // yToTime re-adds the scroll offset via scrollHours (kept in sync by
        // the scroll listener), so adding el.scrollTop here too would count
        // the offset twice — that double-count landed drops +scrollHours late.
        const y = e.clientY - rect.top
        const trackH = 24 * h
        const newTime = snapTo(yToTime(y, trackH, day0, zoom, scrollHours), snapMinutes(zoom))
        // optimistic stage + real write (see `pending` above)
        sendReschedule(dragBlock.task.id, newTime, setPending, setStageErr)
      }
    }
    setDragBlock(null)
    isDragging.current = false
  }, [dragBlock, day0, zoom, scrollHours, h])

  // the tasks broadcast is the source of truth: once a card carries the
  // staged time (or left the board), its in-flight badge retires
  useEffect(() => {
    setPending((m) => retireConfirmed(m, state.tasks))
  }, [state.tasks])

  // move/up live on the shared body container so drags started in the rail
  // (outside the timeline) keep tracking until the pointer drops
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.addEventListener('pointermove', onPointerMove as any)
    el.addEventListener('pointerup', onPointerUp as any)
    return () => {
      el.removeEventListener('pointermove', onPointerMove as any)
      el.removeEventListener('pointerup', onPointerUp as any)
    }
  }, [onPointerMove, onPointerUp])

  // Rendered hours based on zoom.
  const visibleHours = Math.ceil(zoom)
  const startHour = Math.floor(scrollHours)
  const hourLabels = Array.from({ length: visibleHours + 1 }, (_, i) => startHour + i).filter(h => h >= 0 && h < 24)
  const trackH = 24 * h

  // Minute grid: only at ≤1h zoom, 5-min ticks within each hour (skip 0, the
  // hour line already covers it). `h` is the per-hour pixel height.
  const minuteTicks = zoom <= 1
    ? Array.from({ length: 11 }, (_, i) => (i + 1) * 5)
    : []

  return (
    <div className="agenda-body-wrap">
      <div className="agenda-subbar">
        <button
          type="button"
          className="nav-btn"
          title={t('ag.prevDay')}
          aria-label={t('ag.prevDay')}
          onClick={() => setDayOffset((d) => d - 1)}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
        </button>
        <span className="agenda-date">{fmtDayLabel(day0, lang)}</span>
        <button
          type="button"
          className="nav-btn"
          title={t('ag.nextDay')}
          aria-label={t('ag.nextDay')}
          onClick={() => setDayOffset((d) => d + 1)}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
        {!isToday ? (
          <button type="button" className="nav-btn today" onClick={() => setDayOffset(0)}>
            {t('ag.today')}
          </button>
        ) : (
          <span className="agenda-date dim">{t('ag.today')}</span>
        )}
        <span className="agenda-zoom-badge">{zoom}h</span>
        {pending.size > 0 ? (
          <span className="agenda-staged" role="status" title={t('ag.stagedTitle')}>
            {fill(t('ag.staged'), { n: pending.size })}
          </span>
        ) : null}
        {stageErr ? (
          <span className="agenda-staged err" role="alert" title={stageErr}>
            {fill(t('ag.stageErr'), { t: stageErr })}
          </span>
        ) : null}
      </div>
      <div className="agenda-body" ref={bodyRef}>
        <div className="agenda-timeline" ref={scrollRef}>
          <div className="agenda-track" style={{ height: trackH }}>
            {hourLabels.map((hr) => (
              <div className="agenda-hour" key={hr} style={{ top: hr * h, height: h }}>
                <span className="ah-label">{String(hr).padStart(2, '0')}</span>
                <span className="ah-line hour" />
                {zoom > 1 ? <span className="ah-line half" style={{ top: h / 2 }} /> : null}
                {minuteTicks.map((m) => (
                  <span key={m} className="ah-line min" style={{ top: (m / 60) * h }} />
                ))}
              </div>
            ))}
            {blocks.map((b) => (
              <AgendaBlockView
                key={b.task.id}
                block={b}
                now={now}
                pending={pending.has(b.task.id)}
                onOpen={onOpen}
                onDragStart={onPointerDown}
              />
            ))}
            {/* Child blocks (tree grouping) */}
            {blocks.flatMap((b) => b.childBlocks.map((c) => (
              <AgendaBlockView key={c.task.id} block={c} now={now} pending={pending.has(c.task.id)} onOpen={onOpen} onDragStart={onPointerDown} />
            )))}
            {line !== null ? <NowLine pct={line} now={now} /> : null}
          </div>
          {/* Drag ghost */}
          {dragBlock && isDragging.current ? (
            <div className="drag-ghost" style={{ position: 'fixed', top: dragY - 12, left: 120, zIndex: 9999, pointerEvents: 'none' }}>
              {dragBlock.task.title}
            </div>
          ) : null}
        </div>
        <aside className="agenda-unsched">
          <div className="au-head">{t('ag.unschedHead')}</div>
          {side.length === 0 ? (
            <div className="au-empty">{t('ag.unschedEmpty')}</div>
          ) : (
            side.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`au-item ${toneOf(t)}`}
                onClick={() => { if (!clickAfterDrag()) onOpen(t.id) }}
                onPointerDown={(e) => onRailDragStart(e.nativeEvent, t)}
                title={t.resultSummary || t.title}
              >
                <span className="au-dot" />
                <span className="au-title">{t.title}</span>
                {t.dueAt != null ? (
                  <span className="au-due">
                    <Icon name="clock" size={10} /> {fmtStamp(t.dueAt, now)}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </aside>
      </div>
    </div>
  )
}


/* ============================================================
   Schedule list (R136) — the primary calendar form. The proportional
   timeline is a picture of time, but tasks are text: density there turns
   into overlap mush (lanes, glows, pixel-tall blocks). A grouped
   chronological list never overlaps at any density.
   Window: today + 6 days, overdue pinned first, unscheduled sunk last.
   ============================================================ */

const DEFAULT_SLOT_MS = 9 * 3_600_000 // unscheduled item dropped on a day → 09:00

function ScheduleList({ onOpen }: { onOpen(id: string): void }) {
  const { state } = useStore()
  const { t, lang } = useT()
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  // in-flight reschedule marker + error chip (same contract as the timeline)
  const [pending, setPending] = useState<Map<string, number>>(() => new Map())
  const [stageErr, setStageErr] = useState<string | null>(null)
  useEffect(() => {
    if (stageErr === null) return
    const timer = window.setTimeout(() => setStageErr(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [stageErr])
  useEffect(() => {
    setPending((m) => retireConfirmed(m, state.tasks))
  }, [state.tasks])

  // drag a row onto a day header = move there (time-of-day kept); onto the
  // unscheduled header = clear the clock. Unscheduled rows dropped on a day
  // gain the 09:00 default slot.
  const [drag, setDrag] = useState<{ task: Task; scheduled: boolean; x: number; y: number } | null>(null)
  const dragStart = useRef({ x: 0, y: 0, moved: false })
  const rootRef = useRef<HTMLDivElement>(null)

  const onRowDown = useCallback((e: RPointerEvent, task: Task, scheduled: boolean) => {
    dragStart.current = { x: e.clientX, y: e.clientY, moved: false }
    setDrag({ task, scheduled, x: e.clientX, y: e.clientY })
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])
  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!drag) return
    if (
      !dragStart.current.moved &&
      (Math.abs(e.clientX - dragStart.current.x) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - dragStart.current.y) > DRAG_THRESHOLD)
    ) {
      dragStart.current.moved = true
    }
    if (dragStart.current.moved) setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d))
  }, [drag])
  const onPointerUp = useCallback((e: PointerEvent) => {
    const moved = dragStart.current.moved
    dragStart.current.moved = false
    const cur = drag
    setDrag(null)
    if (!cur || !moved) return
    markDragEnd()
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
    const head = el?.closest('.agl-head') as HTMLElement | null
    const unsHead = el?.closest('.agl-uns-head') as HTMLElement | null
    if (head?.dataset.day0 !== undefined) {
      const day0 = Number(head.dataset.day0)
      if (cur.scheduled) {
        const timeOfDay = (cur.task.scheduledAt ?? 0) - dayStartOf(cur.task.scheduledAt ?? 0)
        sendReschedule(cur.task.id, day0 + timeOfDay, setPending, setStageErr)
      } else {
        sendReschedule(cur.task.id, day0 + DEFAULT_SLOT_MS, setPending, setStageErr)
      }
    } else if (unsHead != null && cur.scheduled) {
      sendReschedule(cur.task.id, null, setPending, setStageErr)
    }
  }, [drag])
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    el.addEventListener('pointermove', onPointerMove as unknown as EventListener)
    el.addEventListener('pointerup', onPointerUp as unknown as EventListener)
    return () => {
      el.removeEventListener('pointermove', onPointerMove as unknown as EventListener)
      el.removeEventListener('pointerup', onPointerUp as unknown as EventListener)
    }
  }, [onPointerMove, onPointerUp])

  const now = Date.now() + state.clockOffset
  const today0 = dayStartOf(now)
  const tasks = useMemo(
    () =>
      pending.size === 0
        ? state.tasks
        : state.tasks.map((t) =>
            pending.has(t.id) ? { ...t, scheduledAt: pending.get(t.id) ?? null } : t,
          ),
    [state.tasks, pending],
  )
  const groups = scheduleGroups(tasks, today0, now)
  const over = overdueRows(tasks, today0, now)
  const uns = unscheduledTasks(tasks)

  const weekdayOf = (day0: number): string => dayColHead(day0, lang).weekday
  const headLabel = (day0: number, i: number): string =>
    i === 0 ? t('ag.today') : i === 1 ? t('ag.tomorrow') : `${fmtDayLabel(day0, lang)} ${weekdayOf(day0)}`

  /** A scheduled row: time col + dot + title + chips. */
  const Row = ({ row, showDate }: { row: ScheduleRow; showDate?: boolean }): ReactElement => {
    const tsk = row.task
    const isDone = tsk.status === 'done'
    const cls = [
      'agl-row',
      toneOf(tsk),
      isDone ? 'done' : '',
      row.isOverdue ? 'overdue' : '',
      row.isUpcoming ? 'upcoming' : '',
      pending.has(tsk.id) ? 'pending' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const timeText = showDate ? fmtStamp(row.start, now) : fmtClock(row.start)
    const rangeText =
      row.end != null && !row.spansBeyond && dayStartOf(row.end) === dayStartOf(row.start)
        ? `${timeText}–${fmtClock(row.end)}`
        : timeText
    return (
      <button
        type="button"
        className={cls}
        onClick={() => { if (!clickAfterDrag()) onOpen(tsk.id) }}
        onPointerDown={(e) => onRowDown(e, tsk, true)}
        title={blockTip(tsk)}
      >
        <span className="agl-time">{rangeText}</span>
        <span className="agl-dot" />
        <span className="agl-title">{tsk.title}</span>
        {row.spansBeyond && row.end != null ? (
          <span className="agl-chip">→ {fmtStamp(row.end, now)}</span>
        ) : null}
        {row.isOverdue ? <span className="agl-chip warn">{t('board.dueOver').split(' · ')[0]}</span> : null}
        {pending.has(tsk.id) ? <Icon name="clock" size={10} className="agl-pend" /> : null}
      </button>
    )
  }

  return (
    <div className="agenda-list" ref={rootRef}>
      {pending.size > 0 || stageErr != null ? (
        <div className="agl-status">
          {pending.size > 0 ? (
            <span className="agenda-staged" role="status" title={t('ag.stagedTitle')}>
              {fill(t('ag.staged'), { n: pending.size })}
            </span>
          ) : null}
          {stageErr != null ? (
            <span className="agenda-staged err" role="alert" title={stageErr}>
              {fill(t('ag.stageErr'), { t: stageErr })}
            </span>
          ) : null}
        </div>
      ) : null}

      {over.length > 0 ? (
        <section className="agl-group overdue">
          <div className="agl-head over" title={t('ag.overdueHint')}>
            <span className="agl-head-label">{t('ag.overdueHead')}</span>
            <span className="agl-head-n">{fill(t('ag.itemsN'), { n: over.length })}</span>
          </div>
          {over.map((r) => (
            <Row key={r.task.id} row={r} showDate />
          ))}
        </section>
      ) : null}

      {groups.map((g, i) => {
        const isToday = i === 0
        // empty far-future days are noise — render today and tomorrow always,
        // later days only when they carry rows
        if (g.rows.length === 0 && i > 1) return null
        const nowIdx = isToday
          ? g.rows.findIndex((r) => r.start > now) // divider before the first future row
          : -1
        return (
          <section key={g.day0} className={`agl-group${isToday ? ' today' : ''}`}>
            <div className="agl-head" data-day0={g.day0} title={t('ag.dropToDay')}>
              <span className="agl-head-label">{headLabel(g.day0, i)}</span>
              <span className="agl-head-date">{fmtDayLabel(g.day0, lang)}</span>
              <span className="agl-head-n">
                {g.rows.length > 0 ? fill(t('ag.itemsN'), { n: g.rows.length }) : t('ag.emptyDay')}
              </span>
            </div>
            {g.rows.length === 0 ? (
              <div className="agl-empty">{t('ag.emptyDay')}</div>
            ) : (
              g.rows.map((r, idx) => (
                <Fragment key={r.task.id}>
                  {nowIdx === idx ? (
                    <div className="agl-now" aria-hidden="true">
                      <span className="agl-now-line" />
                      <span className="agl-now-time">{fmtClock(now)}</span>
                    </div>
                  ) : null}
                  <Row row={r} />
                </Fragment>
              ))
            )}
            {isToday && nowIdx === -1 && g.rows.length > 0 ? (
              <div className="agl-now" aria-hidden="true">
                <span className="agl-now-line" />
                <span className="agl-now-time">{fmtClock(now)}</span>
              </div>
            ) : null}
          </section>
        )
      })}

      <section className="agl-group uns">
        <div className="agl-uns-head" title={t('ag.unsDropHint')}>
          <span className="agl-head-label">{t('ag.unschedHead')}</span>
          <span className="agl-head-n">{fill(t('ag.itemsN'), { n: uns.length })}</span>
        </div>
        {uns.length === 0 ? (
          <div className="agl-empty">{t('ag.unsEmpty')}</div>
        ) : (
          uns.map((tsk) => (
            <button
              key={tsk.id}
              type="button"
              className={`agl-row uns ${toneOf(tsk)}`}
              onClick={() => { if (!clickAfterDrag()) onOpen(tsk.id) }}
              onPointerDown={(e) => onRowDown(e, tsk, false)}
              title={t('ag.unsRowHint')}
            >
              <span className="agl-time">—</span>
              <span className="agl-dot" />
              <span className="agl-title">{tsk.title}</span>
              {tsk.dueAt != null ? (
                <span className="agl-chip warn">{fmtStamp(tsk.dueAt, now)}</span>
              ) : null}
            </button>
          ))
        )}
      </section>

      {drag && dragStart.current.moved ? (
        <div
          className="drag-ghost"
          style={{ position: 'fixed', top: drag.y - 12, left: drag.x + 14, zIndex: 9999, pointerEvents: 'none' }}
        >
          {drag.task.title}
        </div>
      ) : null}
    </div>
  )
}

/** The picked mode survives reloads — a reader stays in 日程, a planner
 *  lives in 时间轴. */
function loadAgendaMode(): 'list' | 'timeline' {
  const raw = window.localStorage.getItem('robojex-agenda-mode')
  return raw === 'timeline' ? 'timeline' : 'list'
}

export function AgendaView({ onOpenTask }: { onOpenTask(id: string): void }) {
  const { state } = useStore()
  const { t } = useT()
  const [mode, setMode] = useState<'list' | 'timeline'>(loadAgendaMode)
  useEffect(() => {
    window.localStorage.setItem('robojex-agenda-mode', mode)
  }, [mode])

  if (state.tasks.length === 0) {
    return (
      <div className="agenda-view">
        <div className="board-empty">
          <div className="be-mark">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1.8" y="2.6" width="12.4" height="11.4" rx="2" />
              <path d="M1.8 6.2h12.4M5 1.6v2.4M11 1.6v2.4" />
            </svg>
          </div>
          <p>{t('ag.empty')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="agenda-view">
      <div className="agenda-toolbar">
        <div className="seg" role="group" aria-label={t('ag.modeAria')}>
          <button
            type="button"
            className={mode === 'list' ? 'active' : ''}
            aria-pressed={mode === 'list'}
            onClick={() => setMode('list')}
          >
            {t('ag.modeList')}
          </button>
          <button
            type="button"
            className={mode === 'timeline' ? 'active' : ''}
            aria-pressed={mode === 'timeline'}
            onClick={() => setMode('timeline')}
          >
            {t('ag.modeTimeline')}
          </button>
        </div>
        <span className="agenda-hint">{mode === 'list' ? t('ag.hintList') : t('ag.hintDay')}</span>
      </div>
      {mode === 'list' ? <ScheduleList onOpen={onOpenTask} /> : <DayView onOpen={onOpenTask} />}
    </div>
  )
}
