// packages/web/src/views/LiveActivity.tsx — real-time activity stream (T2):
// in-flight task cards with progress, recent completions, a live
// thinking/decision log and a system heartbeat strip. Vercel deploy-log
// flavour: mono timestamps, pulse dot, newest-first rows sliding in.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { fill, useT } from '../i18n'
import { Icon } from '../ui/Icon'
import { formatTime } from './activityModel'
import {
  agoText,
  decisionStream,
  durationText,
  heartbeat,
  lastBeatTs,
  recentCompletions,
  runningCards,
} from './liveActivityModel'
import type { ActivityItem } from './activityModel'
import './live-activity.css'

/* 1s wall clock — the heartbeat + elapsed labels tick without frame pushes */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

const FRAMEWORKS = ['heroku', 'claude-code', 'codex', 'opencode'] as const

function frameworkBadge(detail: string | undefined): string | null {
  if (!detail) return null
  const low = detail.toLowerCase()
  for (const fw of FRAMEWORKS) if (low.includes(fw)) return fw
  return null
}

/* ── 1. in-flight card ─────────────────────────────────────────────── */

function RunningCardView({
  card,
  now,
  onOpen,
}: {
  card: ReturnType<typeof runningCards>[number]
  now: number
  onOpen(id: string): void
}) {
  const { t } = useT()
  const secs = Math.max(0, Math.round((now - card.startedAt) / 1000))
  const fw = frameworkBadge(card.assignee)
  return (
    <button
      type="button"
      className="la-card rj-animate-in"
      data-testid="live-running-card"
      onClick={() => onOpen(card.id)}
      title={t('live.openTask')}
    >
      <div className="la-card-head">
        <span className="la-dot running" aria-hidden="true" />
        <span className="la-card-title">{card.title}</span>
        {fw ? <span className={`fw-badge ${fw}`}>{fw}</span> : null}
        <span className="la-card-elapsed">{durationText(secs)}</span>
      </div>
      <div className="la-bar">
        {card.progress === null ? (
          <span className="la-bar-fill indeterminate" />
        ) : (
          <span className="la-bar-fill" style={{ width: `${card.progress}%` }} />
        )}
      </div>
      <div className="la-card-progress">
        {card.progress === null ? t('live.inProgress') : `${card.progress}%`}
      </div>
    </button>
  )
}

/* ── 3. log row (shared by decision stream) ────────────────────────── */

function LogRow({ item }: { item: ActivityItem }) {
  const { t } = useT()
  const label = item.labelKey
    ? fill(t(item.labelKey), { n: item.labelParam ?? '' })
    : item.title
  return (
    <div className="la-log-row rj-animate-in" data-testid="live-log-row">
      <span className="la-log-time">{formatTime(item.ts)}</span>
      <span className={`activity-dot ${item.color}`} aria-hidden="true" />
      <span className="la-log-text">
        {item.icon ? <Icon name={item.icon} size={12} style={{ marginRight: 4 }} /> : null}
        {label}
        {item.detail ? <span className="la-log-detail">{item.detail}</span> : null}
      </span>
    </div>
  )
}

/* ── view ──────────────────────────────────────────────────────────── */

export function LiveActivity() {
  const { state, activityItems, selectTask } = useStore()
  const { t } = useT()
  const now = useNow()
  const logRef = useRef<HTMLDivElement>(null)

  const running = useMemo(() => runningCards(state.tasks), [state.tasks])
  const done = useMemo(() => recentCompletions(activityItems), [activityItems])
  const stream = useMemo(() => decisionStream(activityItems), [activityItems])
  const beat = useMemo(
    () => heartbeat(state.conn, lastBeatTs(activityItems), now),
    [state.conn, activityItems, now],
  )

  // newest-first list: snap back to the top when the log grows
  const prevLen = useRef(stream.length)
  useEffect(() => {
    if (stream.length > prevLen.current && logRef.current) {
      logRef.current.scrollTo({ top: 0, behavior: 'smooth' })
    }
    prevLen.current = stream.length
  }, [stream.length])

  const beatLabel =
    beat.level === 'down'
      ? t('live.stateDown')
      : beat.secondsSince === null
        ? t('live.noBeat')
        : fill(t('live.beat'), { n: agoText(beat.secondsSince) })

  return (
    <div className="la-wrap" data-testid="live-activity">
      <header className="la-header">
        <span className={`la-dot ${beat.level}`} aria-hidden="true" />
        <span className="la-title">{t('live.title')}</span>
        <span className={`la-state ${beat.level}`}>{beatLabel}</span>
      </header>

      <section className="la-section" aria-label={t('live.running')}>
        <h3 className="la-section-head">
          {t('live.running')}
          {running.length > 0 ? <span className="la-count">{running.length}</span> : null}
        </h3>
        {running.length === 0 ? (
          <p className="la-empty">{t('live.emptyRunning')}</p>
        ) : (
          running.map((c) => (
            <RunningCardView key={c.id} card={c} now={now} onOpen={selectTask} />
          ))
        )}
      </section>

      <section className="la-section" aria-label={t('live.recent')}>
        <h3 className="la-section-head">{t('live.recent')}</h3>
        {done.length === 0 ? (
          <p className="la-empty">{t('live.emptyRecent')}</p>
        ) : (
          done.map((row) => (
            <div key={row.key} className="la-done-row rj-animate-in">
              <Icon
                name={row.tone === 'done' ? 'check' : 'x'}
                size={12}
                className={row.tone === 'done' ? 'la-ico-ok' : 'la-ico-bad'}
              />
              <span className="la-done-title">{row.title}</span>
              {row.summary ? <span className="la-done-summary">{row.summary}</span> : null}
              <span className="la-done-ago">{agoText(Math.max(0, Math.round((now - row.ts) / 1000)))}</span>
            </div>
          ))
        )}
      </section>

      <section className="la-section la-section-log" aria-label={t('live.stream')}>
        <h3 className="la-section-head">
          {t('live.stream')}
          <span className={`la-dot sm ${beat.level}`} aria-hidden="true" />
        </h3>
        {stream.length === 0 ? (
          <div className="la-empty">
            <div className="activity-skeleton" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="rj-skeleton" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
            <p>{t('live.emptyStream')}</p>
          </div>
        ) : (
          <div className="la-log" ref={logRef}>
            {stream.map((item) => (
              <LogRow key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <footer className="la-footer" role="status">
        <span className={`la-dot sm ${beat.level}`} aria-hidden="true" />
        <span>{t('live.heartbeat')}</span>
        {state.version ? <span className="la-foot-dim">v{state.version}</span> : null}
        <span className="la-foot-dim">{state.mode}</span>
        {state.budget ? <span className="la-foot-dim">{state.budget.line}</span> : null}
      </footer>
    </div>
  )
}
