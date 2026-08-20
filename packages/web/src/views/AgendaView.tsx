// packages/web/src/views/AgendaView.tsx — calendar on the task board. Two
// modes: Day (24h vertical timeline, hour grid, now-line heartbeat, unscheduled
// side list) and Days (7 columns with per-day positioning). Placement math is
// agendaModel.ts; this file owns mode/day state, the scroll-to-now effect and
// the 60s now-line heartbeat.

import { useEffect, useMemo, useRef, useState } from 'react'
import { statusTone, useStore } from '../state/store'
import type { Task } from '../state/types'
import {
  type AgendaBlock,
  blocksForDay,
  dayColumns,
  nowPct,
  unscheduledTasks,
} from './agendaModel'
import { DAY_MS, dayColHead, dayStartOf, fmtClock, fmtDayLabel, fmtStamp } from './timefmt'

/** Day-mode hour row height; 24 rows = 1344px scrollable track. */
const HOUR_H = 56
/** Days-mode compressed track. */
const DAYS_HOUR_H = 32

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
  onOpen,
}: {
  block: AgendaBlock
  now: number
  compact?: boolean
  onOpen(id: string): void
}) {
  const t = block.task
  const s = t.scheduledAt
  const d = t.dueAt
  const range = s != null ? `${fmtClock(s)}${d != null ? `–${fmtClock(d)}` : ''}` : ''
  const low = block.topPct < 12
  return (
    <button
      type="button"
      className={`agenda-block ${toneOf(t)}${compact ? ' compact' : ''}${low ? ' tip-below' : ''}`}
      style={{ top: `${block.topPct}%`, height: `${block.heightPct}%` }}
      data-tip={blockTip(t)}
      title={compact ? `${range} ${t.title}` : undefined}
      onClick={() => onOpen(t.id)}
    >
      {!compact ? <span className="ab-time">{range}</span> : null}
      <span className="ab-title">{t.title}</span>
      {block.spansBeyond && d != null ? (
        <span className="ab-more">→ {fmtStamp(d, now)}</span>
      ) : null}
    </button>
  )
}

function NowLine({ pct, now }: { pct: number; now: number }) {
  return (
    <div className="agenda-now" style={{ top: `${pct}%` }} aria-hidden="true">
      <span className="an-time">{fmtClock(now)}</span>
    </div>
  )
}

function DayView({ onOpen }: { onOpen(id: string): void }) {
  const { state } = useStore()
  const [dayOffset, setDayOffset] = useState(0)
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 60s heartbeat advances the now-line (spec).
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const now = Date.now() + state.clockOffset
  const today0 = dayStartOf(now)
  const day0 = today0 + dayOffset * DAY_MS
  const blocks = useMemo(() => blocksForDay(state.tasks, day0), [state.tasks, day0])
  const side = useMemo(() => unscheduledTasks(state.tasks), [state.tasks])
  const isToday = dayOffset === 0
  const line = isToday ? nowPct(day0, now) : null

  // Default scroll lands the current hour at the top (today only).
  useEffect(() => {
    if (isToday && scrollRef.current)
      scrollRef.current.scrollTop = Math.max(0, ((now - day0) / DAY_MS) * (24 * HOUR_H) - HOUR_H)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isToday])

  return (
    <div className="agenda-body-wrap">
      <div className="agenda-subbar">
        <button
          type="button"
          className="nav-btn"
          title="Previous day"
          aria-label="Previous day"
          onClick={() => setDayOffset((d) => d - 1)}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
        </button>
        <span className="agenda-date">{fmtDayLabel(day0)}</span>
        <button
          type="button"
          className="nav-btn"
          title="Next day"
          aria-label="Next day"
          onClick={() => setDayOffset((d) => d + 1)}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
        {!isToday ? (
          <button type="button" className="nav-btn today" onClick={() => setDayOffset(0)}>
            today
          </button>
        ) : (
          <span className="agenda-date dim">today</span>
        )}
      </div>
      <div className="agenda-body">
        <div className="agenda-timeline" ref={scrollRef}>
          <div className="agenda-track" style={{ height: 24 * HOUR_H }}>
            {Array.from({ length: 24 }, (_, h) => (
              <div className="agenda-hour" key={h} style={{ top: h * HOUR_H }}>
                <span className="ah-label">{String(h).padStart(2, '0')}</span>
                <span className="ah-line hour" />
                <span className="ah-line half" />
              </div>
            ))}
            {blocks.map((b) => (
              <AgendaBlockView key={b.task.id} block={b} now={now} onOpen={onOpen} />
            ))}
            {line !== null ? <NowLine pct={line} now={now} /> : null}
          </div>
        </div>
        <aside className="agenda-unsched">
          <div className="au-head">no time scheduled</div>
          {side.length === 0 ? (
            <div className="au-empty">nothing unscheduled</div>
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
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const now = Date.now() + state.clockOffset
  const dayStart = dayStartOf(now)
  const cols = dayColumns(state.tasks, dayStart)
  const line = nowPct(dayStart, now)

  return (
    <div className="agenda-days">
      <div className="ad-corner" />
      {cols.map((c) => {
        const head = dayColHead(c.day0)
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
          <p>nothing scheduled yet</p>
        </div>
      </div>
    )
  }

  return (
    <div className="agenda-view">
      <div className="agenda-toolbar">
        <div className="seg" role="group" aria-label="Agenda mode">
          <button
            type="button"
            className={mode === 'day' ? 'active' : ''}
            aria-pressed={mode === 'day'}
            onClick={() => setMode('day')}
          >
            Day
          </button>
          <button
            type="button"
            className={mode === 'days' ? 'active' : ''}
            aria-pressed={mode === 'days'}
            onClick={() => setMode('days')}
          >
            7 days
          </button>
        </div>
        <span className="agenda-hint">
          {mode === 'day'
            ? 'click a block to open it on the board'
            : '7-day outlook · blocks span to their due'}
        </span>
      </div>
      {mode === 'day' ? <DayView onOpen={onOpenTask} /> : <DaysView onOpen={onOpenTask} />}
    </div>
  )
}
