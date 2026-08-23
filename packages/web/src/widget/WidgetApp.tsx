// packages/web/src/widget/WidgetApp.tsx — /widget desktop-widget mode.
// 400x600 fixed-viewport mini console: three tabs (minute gantt band,
// progress-ring wall, event feed) auto-rotating every 8s unless pinned.
// Shares the store + theme with the main console via <Providers>.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import { Providers } from '../Providers'
import { Icon } from '../ui/Icon'
import type { TranscriptItem } from '../state/types'
import { fmtClock, fmtStamp } from '../views/timefmt'

// Three rotating tabs. Pinned stops the 8s auto-advance.
type Tab = 'gantt' | 'rings' | 'feed'

const TABS: Tab[] = ['gantt', 'rings', 'feed']
const ROTATE_MS = 8000
// ±1h horizontal time band: a task's scheduledAt/dueAt maps onto a 2h span
// centered on the server-aligned now (now-line sits at 50%).
const WINDOW_MS = 2 * 3_600_000

/** Summarize one transcript entry into a single short line for the feed. */
function feedLine(it: TranscriptItem, t: (key: string) => string): string {
  if (it.kind === 'msg') return `${it.from}: ${it.text.slice(0, 60)}`
  if (it.kind === 'cycle') return fill(t('widget.cycleLine'), { n: (it.actions ?? []).length })
  return it.text.slice(0, 60) // toast
}

export function WidgetApp(): ReactElement {
  const { state: s } = useStore()
  const { t } = useT()
  const [tab, setTab] = useState<Tab>('gantt')
  const [pinned, setPinned] = useState(false)

  // Auto-rotate gantt→rings→feed→gantt every 8s, halted while pinned.
  useEffect(() => {
    if (pinned) return
    const id = setInterval(
      () => setTab((t) => (t === 'gantt' ? 'rings' : t === 'rings' ? 'feed' : 'gantt')),
      ROTATE_MS,
    )
    return () => clearInterval(id)
  }, [pinned])

  // glance clock: a mini console anchored to "now" (minute-resolution tick)
  const [clock, setClock] = useState(() => Date.now() + s.clockOffset)
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now() + s.clockOffset), 15_000)
    return () => clearInterval(id)
  }, [s.clockOffset])


  // alive = any loop traffic: hud events OR cycle frames in the transcript —
  // an idle-but-ticking core must still show a beating heart
  const alive = s.lastHud !== null || s.transcript.some((t) => t.kind === 'cycle')
  const serverNow = Date.now() + (s.clockOffset ?? 0)
  const running = s.tasks.filter((t) => t.status === 'running')
  const sched = s.tasks.filter((t) => (t.scheduledAt || t.dueAt) && t.status !== 'cancelled')
  const overdueLabel = t('widget.overdue')

  // Clicking a tab both selects it and pins the view (manual intent).
  const pick = (t: Tab): void => {
    setTab(t)
    setPinned(true)
  }

  return (
    <div className="widget-root">
      <header className="widget-head">
        <span className={`hud-heart${alive ? ' alive' : ''}`} title={t('widget.heartbeat')} />
        <span className="widget-clock" title={t('widget.clockTitle')}>{fmtClock(clock)}</span>
        <nav>
          {TABS.map((tabId) => (
            <button
              key={tabId}
              type="button"
              className={tabId === tab ? 'on' : ''}
              onClick={() => pick(tabId)}
            >
              {t(`widget.tab.${tabId}`)}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="widget-pin"
          onClick={() => setPinned((p) => !p)}
          title={pinned ? t('widget.unpin') : t('widget.pin')}
          aria-pressed={pinned}
        >
          {pinned ? <Icon name="pin" size={12} /> : <Icon name="pin" size={12} style={{ opacity: 0.45 }} />}
        </button>
        <button
          type="button"
          className="widget-expand"
          onClick={() => location.assign('/')}
          title={t('widget.expand')}
          aria-label={t('widget.expand')}
        >
          <Icon name="maximize" size={12} />
        </button>
      </header>

      {tab === 'gantt' &&
        (sched.length === 0 ? (
          <p className="widle">{t('widget.noSched')}</p>
        ) : (
          <div className="widget-gantt">
            {sched.map((t) => {
              const start = t.scheduledAt ?? t.dueAt!
              const pct = Math.max(
                0,
                Math.min(100, ((start - (serverNow - WINDOW_MS / 2)) / WINDOW_MS) * 100),
              )
              // pills anchor via translateX(-50%); one parked exactly on a
              // window edge half-clips. A glance widget trades geometric
              // purity for readable pills — clamp the anchor inward.
              const anchor = Math.max(12, Math.min(88, pct))
              // overdue ring: past-due live cards keep their status fill but
              // burn at the edge — time pressure survives the glance
              const over = t.dueAt != null && t.dueAt < serverNow && t.status !== 'done' && t.status !== 'cancelled'
              return (
                <div
                  key={t.id}
                  className={`wband st-${t.status}${over ? ' over' : ''}`}
                  style={{ left: `${anchor}%` }}
                  title={`${t.title} · ${fmtStamp(start, serverNow)}${over ? ` · ${overdueLabel}` : ''}`}
                >
                  {t.title.slice(0, 18)}
                </div>
              )
            })}
            <div className="wnow" style={{ left: '50%' }} />
          </div>
        ))}

      {tab === 'rings' && (
        <div className="widget-rings">
          {running.length === 0 ? (
            <p className="widle">{t('widget.idle')}</p>
          ) : (
            running.map((t) => (
              <div key={t.id} className="wring">
                <svg viewBox="0 0 36 36" width="48" height="48" className="ring">
                  <circle cx="18" cy="18" r="15.9" className="ring-bg" />
                  <circle
                    cx="18"
                    cy="18"
                    r="15.9"
                    className={`ring-fg v-${t.verdict ?? 'unchecked'}`}
                    strokeDasharray={`${t.progress ?? 0} 100`}
                    pathLength={100}
                  />
                </svg>
                <span className="wring-label">{t.title.slice(0, 20)}</span>
              </div>
            )))}
        </div>
      )}

      {tab === 'feed' && (
        <ul className="widget-feed">
          {s.transcript.slice(-20).reverse().map((it) => (
            <li key={it.id} className={`wf-${it.kind}`}>
              {feedLine(it, t)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Wrapped widget entry point: same provider stack as the main console. */
export function WidgetAppRoot(): ReactElement {
  return (
    <Providers>
      {() => <WidgetApp />}
    </Providers>
  )
}
