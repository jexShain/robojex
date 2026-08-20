// packages/web/src/chat/ChatStream.tsx — transcript renderer: user bubbles,
// jex markdown, decision cards (cycle frames, one-line collapsed), inline
// toasts (task board transitions), typing dots while a reply is pending.

import { useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { useStore } from '../state/store'
import type { CycleAction, TranscriptItem } from '../state/types'

/** One-decision card; collapsed renders a single summary line. */
function CycleCard({ item }: { item: Extract<TranscriptItem, { kind: 'cycle' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`cycle-card${open ? ' open' : ''}`}>
      <button type="button" className="cycle-head" onClick={() => setOpen(!open)}>
        <svg
          className="chev"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="wake">{item.wake}</span>
        <span className="meta">
          {item.actions.length} action{item.actions.length === 1 ? '' : 's'} ·{' '}
          {item.cost > 0 ? `${item.cost} tok` : '0 tok'}
        </span>
      </button>
      {open ? (
        <div className="cycle-body">
          {item.actions.length === 0 ? (
            <div className="action-row">
              <span className="adetail">no actions this cycle</span>
            </div>
          ) : (
            item.actions.map((a: CycleAction, i) => (
              <div className="action-row" key={i} title={JSON.stringify(a)}>
                <span className="atype">{a.type}</span>
                <span className="adetail">{actionDetail(a)}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function actionDetail(a: CycleAction): string {
  if (typeof a.text === 'string' && a.text) return a.text
  if (typeof a.title === 'string' && a.title) return a.title
  const rest: string[] = []
  for (const [k, v] of Object.entries(a)) {
    if (k === 'type') continue
    if (typeof v === 'string' || typeof v === 'number') rest.push(`${k}=${v}`)
  }
  return rest.join(' ') || JSON.stringify(a)
}

function ToastRow({ item }: { item: Extract<TranscriptItem, { kind: 'toast' }> }) {
  return (
    <div className={`toast-row ${item.tone}`}>
      <span className="dot" />
      <span>{item.text}</span>
    </div>
  )
}

function TranscriptEntry({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'msg':
      if (item.from === 'user') {
        return (
          <div className="msg-user-row">
            <div className="bubble">{item.text}</div>
          </div>
        )
      }
      if (item.from === 'jex') {
        return (
          <div className="msg-jex">
            <Markdown text={item.text} />
          </div>
        )
      }
      return <div className="msg-system">{item.text}</div>
    case 'cycle':
      return <CycleCard item={item} />
    case 'toast':
      return <ToastRow item={item} />
  }
}

export function ChatStream() {
  const { state } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const items = state.transcript

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const lastId = items.length > 0 ? items[items.length - 1]!.id : 0
  const lastKind = items.length > 0 ? items[items.length - 1]!.kind : ''
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [lastId, lastKind, state.waiting])

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      {items.length === 0 && !state.waiting ? (
        <div className="hero">
          <div className="mark">j</div>
          <h1>jex console</h1>
          <p>
            talk to jex, or type <code>/help</code> for commands
          </p>
        </div>
      ) : null}
      {items.map((item) => (
        <TranscriptEntry key={item.id} item={item} />
      ))}
      {state.waiting ? (
        <div className="typing" aria-label="jex is thinking">
          <i />
          <i />
          <i />
        </div>
      ) : null}
    </div>
  )
}
