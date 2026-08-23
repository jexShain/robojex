// packages/web/src/views/AgendaView.tsx — calendar on the task board.
// Modes: Day (zoomable 24h vertical timeline, hour grid, now-line with pulse,
// drag-to-reschedule, overdue/upcoming glow, task-tree grouping) and Days
// (7 columns with per-day positioning).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { statusTone, useStore } from '../state/store'
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
  return (
    <button
      type="button"
      className={cls}
      style={{ top: `${block.topPct}%`, height: `${block.heightPct}%`, marginLeft: indent }}
      data-tip={blockTip(t)}
      title={compact ? `${range} ${t.title}` : undefined}
      onClick={() => onOpen(t.id)}
      onPointerDown={onDragStart ? (e: any) => onDragStart(e.nativeEvent, block) : undefined}
    >
      {!compact ? <span className="ab-time">{range}</span> : null}
      <span className="ab-title">{t.title}</span>
      {pending ? (
        <span className="ab-pend" title={tr('ag.pendingBadge')}>
          ⏳
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
  const [dragBlock, setDragBlock] = useState<AgendaBlock | null>(null)
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

  const now = Date.now() + state.clockOffset
  const today0 = dayStartOf(now)
  const day0 = addDaysLocal(today0, dayOffset)

  // Drag-reschedule staging: the core API only has POST /api/task (create);
  // there is no task-update endpoint, so a drop is staged locally, applied
  // visually and flagged ⏳ — never silently dropped.
  // TODO: send PATCH /api/task/:id { scheduledAt } once ceo-core grows one.
  const [pending, setPending] = useState<Map<string, number>>(() => new Map())
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

  // Drag-to-reschedule handlers.
  const onPointerDown = useCallback((e: PointerEvent, block: AgendaBlock) => {
    dragStartY.current = e.clientY
    isDragging.current = false
    setDragBlock(block)
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
      const y = e.clientY - rect.top + el.scrollTop
      const trackH = 24 * h
      const newTime = snapTo(yToTime(y, trackH, day0, zoom, scrollHours), snapMinutes(zoom))
      // staged locally (see `pending` above) — flagged in the UI, not lost
      console.log(`[drag-reschedule] ${dragBlock.task.id} → ${new Date(newTime).toISOString()} (staged; no backend update endpoint)`)
      setPending((m) => new Map(m).set(dragBlock.task.id, newTime))
    }
    setDragBlock(null)
    isDragging.current = false
  }, [dragBlock, day0, zoom, scrollHours, h])

  useEffect(() => {
    const el = scrollRef.current
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
          <span className="agenda-staged" title={t('ag.stagedTitle')}>
            {fill(t('ag.staged'), { n: pending.size })}
          </span>
        ) : null}
      </div>
      <div className="agenda-body">
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
                onClick={() => onOpen(t.id)}
                title={t.resultSummary || t.title}
              >
                <span className="au-dot" />
                <span className="au-title">{t.title}</span>
                {t.dueAt != null ? (
                  <span className="au-due">⏳ {fmtStamp(t.dueAt, now)}</span>
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
  const { lang } = useT()
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const now = Date.now() + state.clockOffset
  const dayStart = dayStartOf(now)
  const cols = dayColumns(state.tasks, dayStart, now)
  const line = nowPct(dayStart, now)

  return (
    <div className="agenda-days">
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
          <div className="ad-track" style={{ height: 24 * DAYS_HOUR_H }}>
            {c.blocks.map((b) => (
              <AgendaBlockView key={b.task.id} block={b} now={now} compact onOpen={onOpen} />
            ))}
            {c.today && line !== null ? <NowLine pct={line} now={now} /> : null}
          </div>
        </div>
      ))}
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
