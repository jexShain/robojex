// packages/web/src/views/thinkingModel.ts — transforms WS frames into
// a thinking-step timeline for the ThinkingStream panel.

import type { CycleAction, ServerFrame } from '../state/types'

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

let nextId = 0

/** Extract thinking steps from a single WS frame. */
export function frameToThinkingSteps(frame: ServerFrame): ThinkingStep[] {
  switch (frame.t) {
    case 'cycle': {
      const steps: ThinkingStep[] = []
      // Patrol step
      steps.push({
        id: nextId++,
        kind: 'patrol',
        ts: Date.now(),
        label: `🔍 Patrol — ${frame.cost.toFixed(0)} tokens`,
        detail: `Cycle completed. Wake: ${frame.wake}ms, Cost: ${frame.cost} tokens, Actions: ${frame.actions.length}`,
      })
      // Decision step — summarize actions
      if (frame.actions.length > 0) {
        const spawns = frame.actions.filter((a) => a.type === 'spawn')
        const replies = frame.actions.filter((a) => a.type === 'reply')
        const others = frame.actions.filter((a) => a.type !== 'spawn' && a.type !== 'reply')
        let label = '✅ Decision'
        const parts: string[] = []
        if (spawns.length) parts.push(`${spawns.length} spawn(s)`)
        if (replies.length) parts.push(`${replies.length} reply`)
        if (others.length) parts.push(`${others.length} other`)
        if (parts.length) label += ` — ${parts.join(', ')}`
        steps.push({
          id: nextId++,
          kind: 'decision',
          ts: Date.now() + 1,
          label,
          detail: JSON.stringify(frame.actions, null, 2),
        })
        // Spawn sub-steps
        for (const a of spawns) {
          steps.push({
            id: nextId++,
            kind: 'spawn',
            ts: Date.now() + 2,
            label: `⚡ Spawn — ${a.title || a.text || 'unnamed'}`,
            detail: JSON.stringify(a, null, 2),
          })
        }
      }
      return steps
    }
    case 'chat_out': {
      if (frame.from !== 'jex') return []
      return [{
        id: nextId++,
        kind: 'reply',
        ts: frame.ts,
        label: `💬 Reply — ${frame.text.slice(0, 60)}${frame.text.length > 60 ? '…' : ''}`,
        detail: frame.text,
      }]
    }
    default:
      return []
  }
}

/** Returns the 'deciding' placeholder step shown between patrol and decision. */
export function decidingPlaceholder(): ThinkingStep {
  return {
    id: nextId++,
    kind: 'deciding',
    ts: Date.now(),
    label: '🧠 Deciding…',
    detail: '',
  }
}
