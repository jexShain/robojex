// packages/web/src/views/AgendaView.tsx — calendar on the task board.
// Modes: Day (zoomable 24h vertical timeline, hour grid, now-line with pulse,
// drag-to-reschedule, overdue/upcoming glow, task-tree grouping) and Days
// (7 columns with per-day positioning).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { statusTone, useStore } from '../state/store'
import { Icon } from '../ui/Icon'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { Task } from '../state/types'
import {
  type AgendaBlock,
  blocksForDay,
  dayColumns,
  nowPct,
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

/** Day-mode default hour row height. */
const DAYS_HOUR_H = 32
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
  newTime: number,
  setPending: (update: (m: Map<string, number>) => Map<string, number>) => void,
  setStageErr: (v: string) => void,
): void {
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
      onClick={() => onOpen(t.id)}
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

  // Auto-scroll to current hour on today.
  useEffect(() => {
    if (isToday && scrollRef.current) {
      const currentHour = (now - day0) / 3_600_000
      const targetHours = Math.max(0, currentHour - zoom / 3)
      setScrollHours(targetHours)
    }
  }, [isToday, zoom])

  // Wheel zoom.
  const onWheel = useCallback((e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const dir = e.deltaY < 0 ? -1 : 1
      setZoomIdx((i) => clampZoom(i + dir))
    } else {
      // Normal scroll → pan time.
      const pxPerHour = (scrollRef.current?.clientHeight ?? 800) / zoom
      setScrollHours((h) => Math.max(0, h + e.deltaY / pxPerHour))
    }
  }, [zoom])

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
    const el = scrollRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      // only a drop INSIDE the timeline schedules; dropping back on the rail
      // (or elsewhere) is a cancelled gesture, not a slot at that y
      if (e.clientX >= rect.left && e.clientX <= rect.right) {
        const y = e.clientY - rect.top + el.scrollTop
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
                onClick={() => { if (!isDragging.current) onOpen(t.id) }}
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

function DaysView({ onOpen }: { onOpen(id: string): void }) {
  const { state } = useStore()
  const { t, lang } = useT()
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  // drag-reschedule, same contract as the day mode: optimistic stage +
  // PATCH, marker retires on the confirming broadcast
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
  const [drag, setDrag] = useState<{ block: AgendaBlock; x: number; y: number } | null>(null)
  const dragStart = useRef({ x: 0, y: 0, moved: false })
  const rootRef = useRef<HTMLDivElement>(null)

  const now = Date.now() + state.clockOffset
  const dayStart = dayStartOf(now)
  const tasks = useMemo(
    () =>
      pending.size === 0
        ? state.tasks
        : state.tasks.map((t) =>
            pending.has(t.id) ? { ...t, scheduledAt: pending.get(t.id) ?? null } : t,
          ),
    [state.tasks, pending],
  )
  const cols = useMemo(() => dayColumns(tasks, dayStart, now), [tasks, dayStart, now])
  const line = nowPct(dayStart, now)

  const onDragStart = useCallback((e: PointerEvent, block: AgendaBlock) => {
    dragStart.current = { x: e.clientX, y: e.clientY, moved: false }
    setDrag({ block, x: e.clientX, y: e.clientY })
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])
  const onPointerMove = useCallback((e: PointerEvent) => {
    if (
      Math.abs(e.clientX - dragStart.current.x) > DRAG_THRESHOLD ||
      Math.abs(e.clientY - dragStart.current.y) > DRAG_THRESHOLD
    ) {
      dragStart.current.moved = true
    }
    if (dragStart.current.moved) setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d))
  }, [])
  const onPointerUp = useCallback((e: PointerEvent) => {
    const moved = dragStart.current.moved
    dragStart.current.moved = false
    // side effects live OUTSIDE the setState updater — React StrictMode
    // double-invokes updaters and would fire the PATCH twice
    if (drag && moved) {
      // whichever column track the pointer is over wins: its data-day0 is
      // the target day, the y-fraction within the track is the time
      const track = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
        ?.closest('.ad-track') as HTMLElement | null
      const day0 = track?.dataset.day0 !== undefined ? Number(track.dataset.day0) : NaN
      if (track && Number.isFinite(day0)) {
        const rect = track.getBoundingClientRect()
        const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
        const newTime = snapTo(day0 + frac * 86_400_000, 15)
        sendReschedule(drag.block.task.id, newTime, setPending, setStageErr)
      }
    }
    setDrag(null)
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

  return (
    <div className="agenda-days" ref={rootRef}>
      <div className="ad-chips">
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
      <div className="ad-corner" />
      {cols.map((c) => {
        const head = dayColHead(c.day0, lang)
        return (
          <div key={c.day0} className={`ad-head${c.today ? ' today' : ''}`}>
            <b>{head.day}</b>
            <span>{head.weekday}</span>
          </div>
        )
      })}
      <div className="ad-gutter">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} style={{ top: `${(h / 24) * 100}%` }}>
            {String(h).padStart(2, '0')}
          </span>
        ))}
      </div>
      {cols.map((c) => (
        <div key={c.day0} className={`ad-col${c.today ? ' today' : ''}`}>
          <div
            className="ad-track"
            data-day0={c.day0}
            style={{ height: 24 * DAYS_HOUR_H }}
          >
            {c.blocks.map((b) => (
              <AgendaBlockView
                key={b.task.id}
                block={b}
                now={now}
                compact
                pending={pending.has(b.task.id)}
                onOpen={onOpen}
                onDragStart={onDragStart}
              />
            ))}
            {c.today && line !== null ? <NowLine pct={line} now={now} /> : null}
          </div>
        </div>
      ))}
      {drag && dragStart.current.moved ? (
        <div className="drag-ghost" style={{ position: 'fixed', top: drag.y - 12, left: drag.x + 12, zIndex: 9999, pointerEvents: 'none' }}>
          {drag.block.task.title}
        </div>
      ) : null}
    </div>
  )
}

export function AgendaView({ onOpenTask }: { onOpenTask(id: string): void }) {
  const { state } = useStore()
  const { t } = useT()
  const [mode, setMode] = useState<'day' | 'days'>('day')

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
            className={mode === 'day' ? 'active' : ''}
            aria-pressed={mode === 'day'}
            onClick={() => setMode('day')}
          >
            {t('ag.modeDay')}
          </button>
          <button
            type="button"
            className={mode === 'days' ? 'active' : ''}
            aria-pressed={mode === 'days'}
            onClick={() => setMode('days')}
          >
            {t('ag.modeDays')}
          </button>
        </div>
        <span className="agenda-hint">{mode === 'day' ? t('ag.hintDay') : t('ag.hintDays')}</span>
      </div>
      {mode === 'day' ? <DayView onOpen={onOpenTask} /> : <DaysView onOpen={onOpenTask} />}
    </div>
  )
}
