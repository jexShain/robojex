// packages/web/src/views/ThinkingStream.tsx — live reasoning timeline.
// Shows patrol → decide → spawn/reply chain with animations.
//
// Ingest is INCREMENTAL: each transcript change appends steps only for the
// newly arrived items (frame-driven append, not a full rescan). When the
// boundary id no longer matches — e.g. the hello frame rebuilt the transcript
// after a reconnect — the whole timeline is rebuilt from scratch, which also
// lets it shrink (fixes the append-only desync of the old full-rescan code).

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import type { ServerFrame, TranscriptItem } from '../state/types'
import type { ThinkingStep } from './thinkingModel'
import { frameToThinkingSteps } from './thinkingModel'

const MAX_STEPS = 400

const ICONS: Record<ThinkingStep['kind'], string> = {
  patrol: '🔍',
  deciding: '🧠',
  decision: '✅',
  spawn: '⚡',
  reply: '💬',
}

function stepsForItem(item: TranscriptItem): ThinkingStep[] {
  if (item.kind === 'cycle') {
    return frameToThinkingSteps({
      t: 'cycle',
      wake: item.wake,
      cost: item.cost,
      actions: item.actions,
    } as ServerFrame)
  }
  if (item.kind === 'msg' && item.from === 'jex') {
    return frameToThinkingSteps({
      t: 'chat_out',
      from: 'jex',
      text: item.text,
      ts: item.ts,
    } as ServerFrame)
  }
  return []
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
        <span className="ts-icon">{ICONS[step.kind]}</span>
        <span className="ts-time">{time}</span>
        <span className="ts-label">{step.label}</span>
        {step.detail ? (
          <span className="ts-chevron">{expanded ? '▾' : '▸'}</span>
        ) : null}
      </div>
      {expanded && step.detail ? (
        <pre className="ts-detail">{step.detail}</pre>
      ) : null}
    </div>
  )
}

export function ThinkingStream({ embedded = false }: { embedded?: boolean }) {
  const { state } = useStore()
  const [steps, setSteps] = useState<ThinkingStep[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  // ingest cursor: how many transcript items are already in `steps`, and the
  // id of the last one consumed (mismatch ⇒ transcript was rebuilt ⇒ rebuild)
  const consumed = useRef(0)
  const lastId = useRef(-1)
  const mountedFor = useRef(state.transcript)

  useEffect(() => {
    const t = state.transcript
    if (t === mountedFor.current) return
    mountedFor.current = t
    let start = consumed.current
    if (start > t.length || (start > 0 && t[start - 1].id !== lastId.current)) {
      start = 0 // hello rebuilt the ring — start over
    }
    const added: ThinkingStep[] = []
    for (let i = start; i < t.length; i++) added.push(...stepsForItem(t[i]))
    consumed.current = t.length
    lastId.current = t.length > 0 ? t[t.length - 1].id : -1
    if (start === 0) {
      setSteps(added.slice(-MAX_STEPS))
    } else if (added.length > 0) {
      setSteps((prev) => [...prev, ...added].slice(-MAX_STEPS))
    }
  }, [state.transcript])

  // Auto-scroll to latest
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps.length])

  const toggleExpand = (id: number): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className={`thinking-stream${embedded ? ' embedded' : ''}`}>
      {!embedded ? (
        <div className="ts-header">
          <span className="ts-title">Thinking Stream</span>
          <span className="ts-count">{steps.length} steps</span>
        </div>
      ) : null}
      {steps.length === 0 ? (
        <div className="ts-empty">
          <div className="ts-empty-icon">🧠</div>
          <p>waiting for jex's first cycle…</p>
        </div>
      ) : (
        <div className="ts-list" ref={scrollRef}>
          {steps.map((s) => (
            <ThinkingEntry
              key={s.id}
              step={s}
              expanded={expanded.has(s.id)}
              onToggle={() => toggleExpand(s.id)}
            />
          ))}
          {!embedded ? null : (
            <div className="ts-embedded-count">{steps.length} steps</div>
          )}
        </div>
      )}
    </div>
  )
}
