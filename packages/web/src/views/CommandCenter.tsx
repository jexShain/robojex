// packages/web/src/views/CommandCenter.tsx — 「指挥中心」default view
// (SPEC-BUTLER §7): one dynamic board + the AI's thinking log.
// Left ~62%: gantt task board — a 7-day time band (bars from scheduledAt to
// dueAt, colored by status, undated tasks in the 未排程 zone) over status
// swimlanes (todo/running/blocked/done, done collapsible). Right ~38%: live
// think-log stream (cycle/decide/spawn/verify/reflect entries from the same
// transcript GearPanel reads, decide reasoning expandable, stick-to-bottom).
// Top strip: gear chip + policy badge (GET /api/settings, tolerated when the
// core predates the field) + jex heartbeat.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import * as api from '../state/api'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { Task, TranscriptItem } from '../state/types'
import { gearsOrFallback, localizeGears } from './gearDefs'
import {
  type GanttGroup,
  fmtRel,
  ganttWindow,
  groupForGantt,
} from './ganttModel'
import { dayColHead } from './timefmt'
import './command.css'

const NOW_TICK_MS = 30_000
const LOG_SOURCE_ITEMS = 150
const LOG_MAX_ENTRIES = 400

/* ── think-log derivation (pure; same transcript source as ThinkingStream) ── */

export type ThinkKind = 'cycle' | 'decide' | 'reflect' | 'spawn' | 'verify' | 'tool' | 'reply'

export interface ThinkEntry {
  id: string
  ts: number
  kind: ThinkKind
  text: string
  /** expandable reasoning (decide carries the raw action JSON). */
  detail?: string
}

const ACTION_KIND: Record<string, ThinkKind> = {
  spawn: 'spawn',
  verify: 'verify',
  reflect: 'reflect',
  reply: 'reply',
}

/** Cycle actions → one labeled entry each; unknown action types surface as
 * 'tool' so nothing the core invents silently disappears from the log. */
function actionEntry(
  itemId: number,
  idx: number,
  ts: number,
  a: { type: string; text?: string; title?: string },
  t: (key: string) => string,
): ThinkEntry {
  const kind = ACTION_KIND[a.type] ?? 'tool'
  const body = a.title ?? a.text ?? ''
  const prefix =
    kind === 'spawn'
      ? t('cc.action.spawn')
      : kind === 'verify'
        ? t('cc.action.verify')
        : kind === 'reflect'
          ? t('cc.action.reflect')
          : kind === 'reply'
            ? t('cc.action.reply')
            : a.type
  return {
    id: `c${itemId}-a${idx}`,
    ts,
    kind,
    text: `${prefix} · ${String(body).slice(0, 90)}`,
    detail: kind === 'reflect' ? undefined : JSON.stringify(a, null, 2),
  }
}

const KNOWN_ACTIONS = new Set(['spawn', 'verify', 'reflect', 'reply'])
const countKind = (actions: { type: string }[], type: string): number =>
  actions.filter((a) => a.type === type).length

function toThinkEntries(item: TranscriptItem, t: (key: string) => string): ThinkEntry[] {
  if (item.kind === 'cycle') {
    const out: ThinkEntry[] = [
      {
        id: `c${item.id}`,
        ts: item.ts,
        kind: 'cycle',
        text: fill(t('cc.cycleLine'), {
          wake: item.wake,
          cost: Math.round(item.cost),
          n: item.actions.length,
        }),
      },
    ]
    if (item.actions.length > 0) {
      const a = item.actions
      const parts: string[] = []
      if (countKind(a, 'spawn')) parts.push(fill(t('cc.count.spawn'), { n: countKind(a, 'spawn') }))
      if (countKind(a, 'verify')) parts.push(fill(t('cc.count.verify'), { n: countKind(a, 'verify') }))
      if (countKind(a, 'reflect')) parts.push(fill(t('cc.count.reflect'), { n: countKind(a, 'reflect') }))
      if (countKind(a, 'reply')) parts.push(fill(t('cc.count.reply'), { n: countKind(a, 'reply') }))
      const other = a.filter((x) => !KNOWN_ACTIONS.has(x.type)).length
      if (other) parts.push(fill(t('cc.count.other'), { n: other }))
      out.push({
        id: `c${item.id}-d`,
        ts: item.ts,
        kind: 'decide',
        text: fill(t('cc.decisionLine'), { parts: parts.join(' · ') }),
        detail: JSON.stringify(a, null, 2),
      })
      a.forEach((act, i) => out.push(actionEntry(item.id, i, item.ts, act, t)))
    }
    return out
  }
  if (item.kind === 'msg' && item.from === 'jex') {
    // reflect pushes land as chat_out text with the reflected: prefix (SPEC §5)
    if (item.text.startsWith('reflected:')) {
      return [
        {
          id: `m${item.id}`,
          ts: item.ts,
          kind: 'reflect',
          text: fill(t('cc.reflectLine'), { text: item.text.slice('reflected:'.length).trim() }),
        },
      ]
    }
    return [{ id: `m${item.id}`, ts: item.ts, kind: 'reply', text: item.text }]
  }
  return []
}

/* ── small pieces ── */

const VERDICT_GLYPH: Record<string, string> = {
  pass: '✓',
  partial: '◐',
  fail: '✗',
  unchecked: '○',
}

/** Card-corner progress ring + verdict glyph (18px, same vocabulary as the
 * board view's ring). */
function MiniRing({ task }: { task: Task }) {
  const { t } = useT()
  const verdict = (task.verdict ?? '').toLowerCase()
  const v = VERDICT_GLYPH[verdict] ? verdict : 'unchecked'
  const progress = typeof task.progress === 'number' ? Math.max(0, Math.min(100, Math.round(task.progress))) : 0
  return (
    <span className="cc-ring-wrap" title={fill(t('cc.ringTitle'), { n: progress, v })}>
      <svg className="cc-ring" viewBox="0 0 36 36" width="18" height="18" aria-hidden="true">
        <circle cx="18" cy="18" r="15.9" className="ring-bg" />
        <circle cx="18" cy="18" r="15.9" className={`ring-fg v-${v}`} strokeDasharray={`${progress} 100`} pathLength={100} />
      </svg>
      {task.verdict ? <span className={`cc-verdict v-${v}`}>{VERDICT_GLYPH[v]}</span> : null}
    </span>
  )
}

/** Relative-time chip for a card: due → 截止, scheduled → 开始, else creation. */
function RelTime({ task, now }: { task: Task; now: number }) {
  const { t, lang } = useT()
  if (task.dueAt != null)
    return (
      <span className="cc-time due" title={t('cc.due')}>
        ⏳ {fmtRel(task.dueAt, now, lang)}
      </span>
    )
  if (task.scheduledAt != null)
    return (
      <span className="cc-time sched" title={t('cc.start')}>
        ⏱ {fmtRel(task.scheduledAt, now, lang)}
      </span>
    )
  return (
    <span className="cc-time made" title={t('cc.created')}>
      ＋ {fmtRel(task.createdAt, now, lang) ?? '—'}
    </span>
  )
}

/* ── gantt band ── */

function GanttBand({
  group,
  now,
  selectedId,
  onSelect,
}: {
  group: GanttGroup
  now: number
  selectedId: string | null
  onSelect(id: string): void
}) {
  const { t } = useT()
  // window derivation is cheap (dayStartOf + 7 head cells) — no memo needed
  const win = ganttWindow(now)
  const days: { key: number; head: { day: string; weekday: string }; today: boolean }[] = []
  for (let i = 0; i < win.days; i++) {
    const ms = win.start + i * 86_400_000
    days.push({ key: ms, head: dayColHead(ms), today: i === 0 })
  }
  const nowPct = Math.max(0, Math.min(100, ((now - win.start) / (win.end - win.start)) * 100))

  return (
    <div className="cc-band" data-testid="gantt-band">
      <div className="cc-sec-head">
        <span className="cc-sec-title">{fill(t('cc.bandTitle'), { n: win.days })}</span>
        <span className="cc-sec-note">{fill(t('cc.bandScheduled'), { n: group.scheduled.length })}</span>
      </div>
      <div className="cc-band-scroll">
        <div className="cc-band-inner">
          <div className="cc-band-body">
            <div className="cc-days">
              {days.map((d) => (
                <div key={d.key} className={`cc-day${d.today ? ' today' : ''}`}>
                  <b>{d.head.day}</b>
                  <span>{d.head.weekday}</span>
                </div>
              ))}
            </div>
            <div className="cc-rows-scroll">
              <div className="cc-rows">
                {group.scheduled.length === 0 ? (
                  <div className="cc-rows-empty">{t('cc.noScheduled')}</div>
                ) : (
                  group.scheduled.map(({ task, bar }) => (
                    <div
                      key={task.id}
                      className={`cc-row${task.id === selectedId ? ' active' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${task.title} · ${task.status}`}
                      onClick={() => onSelect(task.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect(task.id)
                        }
                      }}
                    >
                      <div
                        className={`cc-bar st-${task.status.toLowerCase()}`}
                        data-testid="gantt-bar"
                        style={{ left: `${bar.startPct}%`, width: `max(${bar.widthPct}%, 6px)` }}
                        title={`${task.title} · ${task.status}`}
                      >
                        <span className="cc-bar-label">{task.title}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            {/* now-line overlays days + rows: stays put while rows scroll */}
            <div className="cc-now" style={{ left: `${nowPct}%` }} aria-hidden="true" />
          </div>
          {group.unscheduled.length > 0 ? (
            <div className="cc-unsched">
              <span className="cc-unsched-label">{t('cc.unsched')}</span>
              <div className="cc-unsched-chips">
                {group.unscheduled.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`cc-chip st-${t.status.toLowerCase()}`}
                    title={t.title}
                    onClick={() => onSelect(t.id)}
                  >
                    {t.title.slice(0, 14)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ── swimlanes ── */

function Swimlanes({
  group,
  now,
  doneCollapsed,
  onToggleDone,
  selectedId,
  onSelect,
}: {
  group: GanttGroup
  now: number
  doneCollapsed: boolean
  onToggleDone(): void
  selectedId: string | null
  onSelect(id: string): void
}) {
  const { t } = useT()
  return (
    <div className="cc-lanes" data-testid="gantt-lanes">
      {group.lanes.map(({ lane, tasks }) => {
        const hidden = lane === 'done' && doneCollapsed
        return (
          <section key={lane} className={`cc-lane lane-${lane}${hidden ? ' shut' : ''}`}>
            <header className="cc-lane-head">
              <span className={`cc-dot ${lane}`} />
              <span className="cc-lane-name">{t(`lane.${lane}`)}</span>
              <span className="cc-lane-count">{tasks.length}</span>
              {lane === 'done' ? (
                <button
                  type="button"
                  className="cc-lane-toggle"
                  aria-pressed={!doneCollapsed}
                  title={doneCollapsed ? t('cc.expandDone') : t('cc.collapseDone')}
                  onClick={onToggleDone}
                >
                  {doneCollapsed ? '▸' : '▾'}
                </button>
              ) : null}
            </header>
            <div className="cc-cards">
              {!hidden &&
                tasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className={`cc-card${task.id === selectedId ? ' active' : ''}`}
                    data-testid="gantt-card"
                    onClick={() => onSelect(task.id)}
                  >
                    <span className="cc-card-title">{task.title}</span>
                    <span className="cc-card-meta">
                      <MiniRing task={task} />
                      <RelTime task={task} now={now} />
                    </span>
                  </button>
                ))}
              {hidden && tasks.length > 0 ? (
                <div className="cc-lane-hint">{fill(t('cc.folded'), { n: tasks.length })}</div>
              ) : null}
              {!hidden && tasks.length === 0 ? <div className="cc-lane-hint">—</div> : null}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/* ── think log ── */

const hhmmss = (ts: number): string =>
  new Date(ts).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

function ThinkItem({
  entry,
  expanded,
  onToggle,
}: {
  entry: ThinkEntry
  expanded: boolean
  onToggle(): void
}) {
  const { t } = useT()
  const hasDetail = typeof entry.detail === 'string' && entry.detail.length > 0
  return (
    <div className="cc-item rj-animate-in" data-testid="think-item" data-kind={entry.kind}>
      <button type="button" className="cc-item-main" onClick={hasDetail ? onToggle : undefined} aria-expanded={hasDetail ? expanded : undefined}>
        <time className="cc-item-time">{hhmmss(entry.ts)}</time>
        <span className={`cc-item-kind k-${entry.kind}`}>{t(`cc.think.${entry.kind}`)}</span>
        <span className="cc-item-text">{entry.text}</span>
        {hasDetail ? <span className="cc-item-chev">{expanded ? '▾' : '▸'}</span> : null}
      </button>
      {expanded && hasDetail ? <pre className="cc-item-detail">{entry.detail}</pre> : null}
    </div>
  )
}

function ThinkLog() {
  const { state } = useStore()
  const { t } = useT()
  const entries = useMemo(() => {
    const source = state.transcript.slice(-LOG_SOURCE_ITEMS)
    return source.flatMap((item) => toThinkEntries(item, t)).slice(-LOG_MAX_ENTRIES)
  }, [state.transcript, t])

  // stick-to-bottom (ChatView pattern): follow while the user is near the
  // bottom, pause when they scroll up, jump button re-arms following.
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [jump, setJump] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = near
    setJump((prev) => (prev === !near ? prev : !near))
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries.length, entries[entries.length - 1]?.text.length])

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stick.current = true
    setJump(false)
  }

  return (
    <div className="cc-log" data-testid="think-log">
      <div className="cc-sec-head">
        <span className="cc-sec-title">{t('cc.thinkLog')}</span>
        <span className={`hud-heart${state.conn === 'live' ? ' alive' : ''}`} data-testid="jex-heart" title={t('cc.jexHeart')} />
        <span className="cc-sec-note">{fill(t('cc.entries'), { n: entries.length })}</span>
      </div>
      <div className="cc-log-list" ref={scrollRef} onScroll={onScroll}>
        {entries.length === 0 ? (
          <div className="cc-log-empty">
            <div className="cc-log-empty-icon">🧠</div>
            <p>{t('cc.waitFirst')}</p>
          </div>
        ) : (
          entries.map((e) => (
            <ThinkItem
              key={e.id}
              entry={e}
              expanded={expanded.has(e.id)}
              onToggle={() =>
                setExpanded((s) => {
                  const next = new Set(s)
                  if (next.has(e.id)) next.delete(e.id)
                  else next.add(e.id)
                  return next
                })
              }
            />
          ))
        )}
      </div>
      {jump && entries.length > 0 ? (
        <button type="button" className="cc-jump" onClick={scrollToBottom} aria-label={t('cc.backToBottom')}>
          {t('cc.latest')}
        </button>
      ) : null}
    </div>
  )
}

/* ── the view ── */

export function CommandCenter() {
  const { state, selectTask } = useStore()
  const { t } = useT()
  const [doneCollapsed, setDoneCollapsed] = useState(true)
  const [, setTick] = useState(0)

  // policy badge (SPEC-BUTLER §1/§7): GET /api/settings; the field is absent
  // on pre-butler cores and the whole call can fail — either way, no badge.
  const [policy, setPolicy] = useState<'butler' | 'conservative' | null>(null)
  useEffect(() => {
    let alive = true
    api
      .getSettings()
      .then((s) => {
        if (alive) setPolicy(s.policy === 'butler' || s.policy === 'conservative' ? s.policy : null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // aligned clock, re-rendered every 30s so relative times / the now-line drift
  const now = Date.now() + state.clockOffset
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), NOW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  // group on the 30s tick (window follows midnight rollovers); groupForGantt
  // is cheap but re-sorts, so keep it out of the per-frame path
  const nowTick = Math.floor(now / NOW_TICK_MS)
  const group = useMemo(
    () => groupForGantt(state.tasks, ganttWindow(now)),
    [state.tasks, nowTick], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const gears = localizeGears(gearsOrFallback(state.gears), t)
  const cur = gears.find((g) => g.id === state.gear) ?? gears[0]
  const busy = state.stream.status === 'streaming' || state.waiting

  return (
    <div className="command-center" data-testid="cmd-center">
      <header className="cc-top">
        {cur ? (
          <span
            className={`cc-gear-chip${busy ? ' busy' : ''}`}
            style={{ '--cc-gear': `var(--rj-gear-${cur.level})` } as CSSProperties}
            title={fill(t('cc.gearTitle'), { name: cur.name, desc: cur.desc })}
          >
            <span className="cc-gear-emoji">{cur.emoji}</span>
            {cur.name}
          </span>
        ) : null}
        {policy ? (
          <span
            className={`cc-policy ${policy}`}
            data-testid="policy-badge"
            data-policy={policy}
            title={policy === 'butler' ? t('cc.policy.butlerTitle') : t('cc.policy.conservativeTitle')}
          >
            {policy === 'butler' ? t('cc.policy.butler') : t('cc.policy.conservative')}
          </span>
        ) : null}
        <span className={`hud-heart${state.conn === 'live' ? ' alive' : ''}`} data-testid="jex-heart" title={t('cc.jexHeart')} />
        <span className="cc-top-count" title={t('cc.tasksTitle')}>
          {fill(t('cc.taskCount'), { n: state.tasks.length })}
        </span>
      </header>

      <div className="cc-body">
        <section className="cc-left" data-testid="gantt-board">
          <GanttBand group={group} now={now} selectedId={state.selectedTaskId} onSelect={selectTask} />
          <div className="cc-lanes-wrap">
            <div className="cc-sec-head">
              <span className="cc-sec-title">{t('cc.board')}</span>
              <span className="cc-sec-note">{fill(t('cc.unschedCount'), { n: group.unscheduled.length })}</span>
            </div>
            <div className="cc-lanes-scroll">
              <Swimlanes
                group={group}
                now={now}
                doneCollapsed={doneCollapsed}
                onToggleDone={() => setDoneCollapsed((c) => !c)}
                selectedId={state.selectedTaskId}
                onSelect={selectTask}
              />
            </div>
          </div>
        </section>

        <section className="cc-right">
          <ThinkLog />
        </section>
      </div>
    </div>
  )
}
