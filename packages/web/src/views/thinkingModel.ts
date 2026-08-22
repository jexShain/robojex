// packages/web/src/views/thinkingModel.ts — transforms WS frames into
// a thinking-step timeline for the ThinkingStream panel.

import type { ServerFrame } from '../state/types'
import { fill } from '../i18n/event'

export type ThinkingKind =
  | 'patrol'
  | 'deciding'
  | 'decision'
  | 'spawn'
  | 'reply'

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
}

let _seq = 0
function seqId(): number { return ++_seq }

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
