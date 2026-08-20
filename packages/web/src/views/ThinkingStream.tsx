// packages/web/src/views/ThinkingStream.tsx — live reasoning timeline.
// Shows patrol → decide → spawn/reply chain with animations.

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import type { ThinkingStep } from './thinkingModel'
import { frameToThinkingSteps } from './thinkingModel'

const ICONS: Record<ThinkingStep['kind'], string> = {
  patrol: '🔍',
  deciding: '🧠',
  decision: '✅',
  spawn: '⚡',
  reply: '💬',
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

export function ThinkingStream() {
  const { state } = useStore()
  const [steps, setSteps] = useState<ThinkingStep[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)

  // Process transcript into thinking steps
  useEffect(() => {
    const newSteps: ThinkingStep[] = []
    for (const item of state.transcript) {
      if (item.kind === 'cycle') {
        // Show 'deciding' skeleton before decision arrives
        newSteps.push(...frameToThinkingSteps({ t: 'cycle', wake: item.wake, cost: item.cost, actions: item.actions }))
      } else if (item.kind === 'msg' && item.from === 'jex') {
        newSteps.push(...frameToThinkingSteps({ t: 'chat_out', from: 'jex', text: item.text, ts: item.ts }))
      }
    }
    if (newSteps.length > steps.length) {
      setSteps(newSteps)
    }
  }, [state.transcript]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to latest
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps.length])

  const toggleExpand = (id: number) => {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (steps.length === 0) {
    return (
      <div className="thinking-stream">
        <div className="ts-empty">
          <div className="ts-empty-icon">🧠</div>
          <p>waiting for jex's first cycle…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="thinking-stream">
      <div className="ts-header">
        <span className="ts-title">Thinking Stream</span>
        <span className="ts-count">{steps.length} steps</span>
      </div>
      <div className="ts-list" ref={scrollRef}>
        {steps.map((s) => (
          <ThinkingEntry
            key={s.id}
            step={s}
            expanded={expanded.has(s.id)}
            onToggle={() => toggleExpand(s.id)}
          />
        ))}
      </div>
    </div>
  )
}
