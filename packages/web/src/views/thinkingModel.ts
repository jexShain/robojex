// packages/web/src/views/thinkingModel.ts — transforms WS frames into
// a thinking-step timeline for the ThinkingStream panel.

import type { ServerFrame, ThinkStep } from '../state/types'
import { fill } from '../i18n/event'

/** Backend event kinds (vitals / watchdog / repeat-guard rounds) — the
 * classifier below promotes matching event texts to their own step. */
export type EventKind = 'plan' | 'stall' | 'morning' | 'awaiting' | 'stuck'

/** T7 trace step kinds the live `think` frames ship (loop.ts tracePhase);
 * 'decision' reuses the cycle-summary visual for the decide plan step. */
export type TraceKind = 'wake' | 'decide' | 'done' | 'audit' | 'auditReview' | 'error'

export type ThinkingKind =
  | 'patrol'
  | 'deciding'
  | 'decision'
  | 'spawn'
  | 'reply'
  | EventKind
  | TraceKind

export interface ThinkingStep {
  id: number
  kind: ThinkingKind
  ts: number
  /** Short label shown in the timeline. */
  label: string
  /** Detail text — shown on expand. */
  detail: string
  /** Related task IDs (for spawn). */
  taskIds?: string[]
  /** T7: the token bill this phase paid (absent = no LLM cost attributed). */
  tokens?: number
  /** T7: the wake group this step belongs to (trace steps carry it; the
   *  renderer folds consecutive same-wake steps into one collapsible block). */
  wake?: number
  /** True while this wake's cycle has not settled yet (last open group). */
  live?: boolean
}

let _seq = 0
function seqId(): number { return ++_seq }

/* ── backend event highlighting ── */

/** Wake-event prefixes that earn their own timeline kind (loop.ts push()):
 * plan_created (计划制定) / loop_stalled (心跳停滞自恢复) /
 * morning_briefing (晨报). First match wins. */
const EVENT_PREFIX_KIND: ReadonlyArray<readonly [prefix: string, kind: EventKind]> = [
  ['plan_created:', 'plan'],
  ['loop_stalled:', 'stall'],
  ['morning_briefing:', 'morning'],
]

/**
 * Classify an event/chat text against the highlightable backend events.
 * `verify_due:` only promotes to 'awaiting' (悬置验收) when the
 * orphaned-acceptance marker rides along — a plain nudge stays a normal
 * line; the identical-call death-spiral warning is appended to the tail of
 * tool-result events, so it is matched anywhere. Returns null for plain
 * text (reply/reflected/... keep their existing treatment).
 */
export function eventKindOf(text: string): EventKind | null {
  for (const [prefix, kind] of EVENT_PREFIX_KIND) if (text.startsWith(prefix)) return kind
  if (text.startsWith('verify_due:') && text.includes('[awaiting acceptance')) return 'awaiting'
  if (text.includes('[WARNING: identical call')) return 'stuck'
  return null
}

/** Payload half of a classified event: the prefix is redundant once the
 * badge carries it. 'stuck' has no prefix (a tail marker) — full text. */
export function eventPayload(text: string, kind: EventKind): string {
  return kind === 'stuck' ? text : text.slice(text.indexOf(':') + 1).trim()
}

/** Extract thinking steps from a single WS frame. `t` localizes the fixed
 * labels (i18n ts.* keys carry emoji + {placeholders} already). */
export function frameToThinkingSteps(
  frame: ServerFrame,
  t: (key: string) => string,
): ThinkingStep[] {
  switch (frame.t) {
    case 'cycle': {
      const steps: ThinkingStep[] = []
      // Patrol step
      steps.push({
        id: seqId(),
        kind: 'patrol',
        ts: Date.now(),
        label: fill(t('ts.patrol'), { n: frame.cost.toFixed(0) }),
        detail: fill(t('ts.patrolDetail'), {
          wake: frame.wake,
          cost: frame.cost,
          n: frame.actions.length,
        }),
      })
      // Decision step — summarize actions
      if (frame.actions.length > 0) {
        const spawns = frame.actions.filter((a) => a.type === 'spawn')
        const replies = frame.actions.filter((a) => a.type === 'reply')
        const others = frame.actions.filter((a) => a.type !== 'spawn' && a.type !== 'reply')
        let label = t('ts.decision')
        const parts: string[] = []
        if (spawns.length) parts.push(fill(t('ts.spawnCount'), { n: spawns.length }))
        if (replies.length) parts.push(fill(t('ts.replyCount'), { n: replies.length }))
        if (others.length) parts.push(fill(t('ts.otherCount'), { n: others.length }))
        if (parts.length) label += ` — ${parts.join(', ')}`
        steps.push({
          id: seqId(),
          kind: 'decision',
          ts: Date.now() + 1,
          label,
          detail: JSON.stringify(frame.actions, null, 2),
        })
        // Spawn sub-steps
        for (const a of spawns) {
          steps.push({
            id: seqId(),
            kind: 'spawn',
            ts: Date.now() + 2,
            label: fill(t('ts.spawn'), { title: a.title || a.text || t('ts.unnamed') }),
            detail: JSON.stringify(a, null, 2),
          })
        }
      }
      return steps
    }
    case 'chat_out': {
      if (frame.from !== 'jex') return []
      // backend events (plan/stall/morning/awaiting/stuck) get their own
      // step kind before the generic reply treatment
      const ev = eventKindOf(frame.text)
      if (ev) {
        const payload = eventPayload(frame.text, ev)
        const brief = `${payload.slice(0, 60)}${payload.length > 60 ? '…' : ''}`
        return [{
          id: seqId(),
          kind: ev,
          ts: frame.ts,
          label: fill(t(`ts.${ev}`), { text: brief }),
          detail: frame.text,
        }]
      }
      const brief = `${frame.text.slice(0, 60)}${frame.text.length > 60 ? '…' : ''}`
      return [{
        id: seqId(),
        kind: 'reply',
        ts: frame.ts,
        label: fill(t('ts.reply'), { text: brief }),
        detail: frame.text,
      }]
    }
    default:
      return []
  }
}

/** Returns the 'deciding' placeholder step shown between patrol and decision. */
export function decidingPlaceholder(t: (key: string) => string): ThinkingStep {
  return {
    id: seqId(),
    kind: 'deciding',
    ts: Date.now(),
    label: t('ts.deciding'),
    detail: '',
  }
}

/* ── T7: backend trace steps → timeline (the live thinking stream) ── */

/** Compact token count for badges: 1234 → "1.2k", 900 → "900". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Map one backend ThinkStep onto the timeline. Labels come from ts.* keys;
 *  unknown step kinds (a newer core) render as a generic labelled line with
 *  their raw kind, so the stream never drops a step on the floor. */
export function traceToThinkingStep(
  step: ThinkStep,
  t: (key: string) => string,
): ThinkingStep {
  const brief = (s: string): string => `${s.slice(0, 60)}${s.length > 60 ? '…' : ''}`
  let label = step.kind
  let detail = step.detail ?? ''
  switch (step.kind) {
    case 'wake':
      label = fill(t('ts.wake'), { n: step.wake ?? '?' })
      break
    case 'patrol':
      label = fill(t('ts.patrolVerdict'), { verdict: String(step.verdict ?? '?'), n: fmtTokens(step.tokens ?? 0) })
      break
    case 'decide': {
      const acts = step.actions ?? []
      const kinds = acts.map((a) => (a.title ? `${a.type}(${brief(a.title)})` : a.type))
      label = fill(t('ts.decisionPlan'), { n: acts.length })
      detail = kinds.length > 0 ? `${kinds.join('\n')}\n\n${detail}` : detail
      break
    }
    case 'spawn':
      label = fill(t('ts.spawn'), { title: step.title ?? t('ts.unnamed') })
      break
    case 'spawn_done':
      label = fill(t(step.ok === false ? 'ts.doneFail' : 'ts.doneOk'), {
        title: step.title ?? t('ts.unnamed'),
      })
      break
    case 'audit':
      label = t('ts.audit')
      break
    case 'audit_review':
      label = t('ts.auditReview')
      break
    case 'error':
      label = t('ts.error')
      break
    default:
      // forward-compatible: a kind this build doesn't know still shows up
      label = `${step.kind}${detail ? ` — ${brief(detail)}` : ''}`
      break
  }
  return {
    id: step.id,
    kind: step.kind === 'decide' ? 'decision' : step.kind === 'spawn_done' ? 'done' : (step.kind as ThinkingStep['kind']),
    ts: step.ts,
    label,
    detail,
    tokens: step.tokens,
    wake: step.wake,
    taskIds: step.taskId ? [step.taskId] : undefined,
  }
}
