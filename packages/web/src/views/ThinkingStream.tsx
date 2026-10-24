// packages/web/src/views/ThinkingStream.tsx — live reasoning timeline (T7).
// Two feeds merge into one wall-clock-ordered stream:
//  1. state.thinking — backend trace steps (wake → patrol → decide plan →
//     spawn/spawn_done → audit → audit_review), streamed live as `think`
//     frames, so each phase appears the moment it happens, each carrying
//     its own timestamp and token bill;
//  2. the legacy transcript — jex replies and classified backend events,
//     plus the old cycle-summary derivation for cores without traces.
// Consecutive trace steps of one wake fold into a collapsible block in the
// Vercel build-log idiom: one compact header line (wake · time · total
// tokens · step count), the phase log expands underneath. The newest open
// group pulses to show jex is mid-thought.
//
// Steps arrive from three overlapping sources (hello replay, live think
// frames, cycle-frame trace); the store already deduplicates on the backend
// step id, so this renderer treats the window as ground truth.

import { useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import type { ServerFrame, ThinkStep, TranscriptItem } from '../state/types'
import type { ThinkingStep } from './thinkingModel'
import { fmtTokens, frameToThinkingSteps, traceToThinkingStep } from './thinkingModel'

const MAX_STEPS = 400

const ICONS: Partial<Record<ThinkingStep['kind'], IconName>> & { fallback: IconName } = {
  wake: 'gauge',
  patrol: 'search',
  deciding: 'brain',
  decision: 'brain',
  spawn: 'zap',
  done: 'check',
  reply: 'message',
  audit: 'database',
  auditReview: 'scale',
  error: 'ban',
  // backend event kinds (thinkingModel.eventKindOf)
  plan: 'grid',
  stall: 'ban',
  morning: 'sun',
  awaiting: 'scale',
  stuck: 'repeat',
  fallback: 'gauge',
} as const

function iconFor(kind: ThinkingStep['kind']): IconName {
  return ICONS[kind] ?? ICONS.fallback
}

function stepsForItem(item: TranscriptItem, t: (key: string) => string): ThinkingStep[] {
  if (item.kind === 'cycle') {
    // T7: a traced cycle already streams via state.thinking — deriving the
    // legacy summary too would double every patrol/decide/spawn line. Only
    // trace-less (older) cores get the frame-derived summary.
    if (item.trace && item.trace.length > 0) return []
    return frameToThinkingSteps(
      {
        t: 'cycle',
        wake: item.wake,
        cost: item.cost,
        actions: item.actions,
      } as ServerFrame,
      t,
    )
  }
  if (item.kind === 'msg' && item.from === 'jex') {
    return frameToThinkingSteps(
      {
        t: 'chat_out',
        from: 'jex',
        text: item.text,
        ts: item.ts,
      } as ServerFrame,
      t,
    )
  }
  return []
}

/** One collapsible wake block (Vercel build-log idiom). */
function CycleGroup({
  wake,
  group,
  open,
  live,
  onToggle,
  expanded,
  onToggleStep,
  t,
}: {
  wake: number
  group: ThinkingStep[]
  open: boolean
  live: boolean
  onToggle(): void
  expanded: Set<number>
  onToggleStep(id: number): void
  t: (key: string) => string
}) {
  const first = group[0]!
  const totalTokens = group.reduce((s, x) => s + (x.tokens ?? 0), 0)
  const time = new Date(first.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className={['ts-group', live ? 'ts-group-live' : '', 'rj-animate-in'].filter(Boolean).join(' ')}>
      <div className="ts-group-head" onClick={onToggle}>
        <span className="ts-chevron">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
        <span className={`ts-icon${live ? ' ts-live-dot' : ''}`}>
          <Icon name={live ? 'brain' : 'gauge'} size={14} />
        </span>
        <span className="ts-time">{time}</span>
        <span className="ts-label">
          {fill(t('ts.wakeGroup'), { n: wake })}
          {live ? <span className="ts-live-text"> {t('ts.live')}</span> : null}
        </span>
        <span className="ts-step-count">{fill(t('ts.stepN'), { n: group.length })}</span>
        {totalTokens > 0 ? <span className="ts-token">{'⚡'} {fmtTokens(totalTokens)}</span> : null}
      </div>
      {open ? (
        <div className="ts-group-body">
          {group.map((s) => (
            <ThinkingEntry key={s.id} step={s} expanded={expanded.has(s.id)} onToggle={() => onToggleStep(s.id)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingEntry({
  step,
  expanded,
  onToggle,
}: {
  step: ThinkingStep
  expanded: boolean
  onToggle(): void
}) {
  const time = new Date(step.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className={['ts-entry', 'rj-animate-in', `ts-${step.kind}`].filter(Boolean).join(' ')}>
      <div className="ts-main" onClick={onToggle}>
        <span className="ts-icon">
          <Icon name={iconFor(step.kind)} size={14} />
        </span>
        <span className="ts-time">{time}</span>
        <span className="ts-label">{step.label}</span>
        {step.tokens ? <span className="ts-token">{'⚡'} {fmtTokens(step.tokens)}</span> : null}
        {step.detail ? (
          <span className="ts-chevron"><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} /></span>
        ) : null}
      </div>
      {expanded && step.detail ? (
        <pre className="ts-detail">{step.detail}</pre>
      ) : null}
    </div>
  )
}

/** A rendered row: either a folded wake group or a standalone step. */
type Row =
  | { type: 'group'; wake: number; ts: number; group: ThinkingStep[] }
  | { type: 'step'; ts: number; step: ThinkingStep }

function buildRows(
  thinking: ThinkStep[],
  transcript: TranscriptItem[],
  t: (key: string) => string,
): Row[] {
  const trace = thinking.map((s) => traceToThinkingStep(s, t))
  const legacy: ThinkingStep[] = []
  for (const item of transcript) legacy.push(...stepsForItem(item, t))
  const merged = [...trace, ...legacy].sort((a, b) => a.ts - b.ts).slice(-MAX_STEPS)

  // Fold consecutive same-wake trace steps into groups; wake-less steps
  // (replies, legacy summaries) stay standalone rows in place.
  const rows: Row[] = []
  let run: ThinkingStep[] = []
  let runWake: number | undefined
  const flush = (): void => {
    if (run.length === 0) return
    if (runWake !== undefined && run.length > 1) {
      rows.push({ type: 'group', wake: runWake, ts: run[0]!.ts, group: run })
    } else {
      for (const s of run) rows.push({ type: 'step', ts: s.ts, step: s })
    }
    run = []
    runWake = undefined
  }
  for (const s of merged) {
    if (s.wake !== undefined && s.wake === runWake) run.push(s)
    else {
      flush()
      runWake = s.wake
      run = [s]
    }
  }
  flush()
  return rows
}

export function ThinkingStream({ embedded = false }: { embedded?: boolean }) {
  const { state } = useStore()
  const { t, lang } = useT()
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const rows = useMemo(
    () => buildRows(state.thinking, state.transcript, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.thinking, state.transcript, lang],
  )

  // A wake group is still open (jex mid-thought) when its cycle frame has
  // not landed yet — the transcript carries one cycle item per finished wake.
  const settledWakes = useMemo(() => {
    const done = new Set<number>()
    for (const item of state.transcript) if (item.kind === 'cycle') done.add(item.wake)
    return done
  }, [state.transcript])

  // Auto-expand the live group so the streaming phases are visible by default
  const lastRow = rows[rows.length - 1]
  const liveWake = lastRow?.type === 'group' && !settledWakes.has(lastRow.wake) ? lastRow.wake : undefined

  const totalTokens = useMemo(
    () => state.thinking.reduce((s, x) => s + (x.tokens ?? 0), 0),
    [state.thinking],
  )
  const stepCount = rows.reduce((n, r) => n + (r.type === 'group' ? r.group.length : 1), 0)

  const toggleGroup = (wake: number): void => {
    setOpenGroups((s) => {
      const next = new Set(s)
      if (next.has(wake)) next.delete(wake)
      else next.add(wake)
      return next
    })
  }
  const toggleExpand = (id: number): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Auto-scroll to the newest line
  const scrollTop = (el: HTMLDivElement | null): void => { if (el) el.scrollTop = el.scrollHeight }

  return (
    <div className={`thinking-stream${embedded ? ' embedded' : ''}`}>
      {!embedded ? (
        <div className="ts-header">
          <span className="ts-title">{t('ts.title')}</span>
          <span className="ts-count">{fill(t('ts.steps'), { n: stepCount })}</span>
          {totalTokens > 0 ? <span className="ts-token">{'⚡'} {fmtTokens(totalTokens)}</span> : null}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="ts-empty">
          <div className="ts-empty-icon">
            <Icon name="brain" size={36} />
          </div>
          <p>{t('ts.empty')}</p>
        </div>
      ) : (
        <div className="ts-list" ref={scrollTop}>
          {rows.map((row) =>
            row.type === 'group' ? (
              <CycleGroup
                key={`g-${row.wake}`}
                wake={row.wake}
                group={row.group}
                open={openGroups.has(row.wake) || row.wake === liveWake}
                live={row.wake === liveWake}
                onToggle={() => toggleGroup(row.wake)}
                expanded={expanded}
                onToggleStep={toggleExpand}
                t={t}
              />
            ) : (
              <ThinkingEntry
                key={`s-${row.step.id}`}
                step={row.step}
                expanded={expanded.has(row.step.id)}
                onToggle={() => toggleExpand(row.step.id)}
              />
            ),
          )}
          {!embedded ? null : (
            <div className="ts-embedded-count">{fill(t('ts.steps'), { n: state.thinking.length })}</div>
          )}
        </div>
      )}
    </div>
  )
}
