// packages/web/src/chat/ChatView.tsx — the chat core, composed and exported:
// EmptyState (brand orb + example prompt cards) → message stream (user
// bubbles / full-width assistant / notice pills) with thinking fold, streaming
// cursor, usage badges, hover actions (copy / edit-resend / regenerate /
// delete), error cards → floating InputBar. Scroll sticks to bottom while the
// user is near it; a fade-in jump button returns to the latest message.
// AppFrame mounts this once and keeps it mounted across view switches.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useStore } from '../state/store'
import type { Message } from '../state/types'
import { Markdown } from './Markdown'
import { InputBar } from './InputBar'
import './chat.css'

/* ── icons (inline, 24×24 stroke) ── */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const
const BoltIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
)
const CopyIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)
const CheckIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const PencilIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
)
const TrashIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
)
const RefreshIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
)
const ChevronIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" {...stroke} className="chev" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
)

/* ── shared helpers ── */

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable — feedback is skipped by the caller */
  }
}

/** Delete `msgId` (when inclusive) and everything after it, tail-first so the
 * list collapses naturally. Uses only the store contract. */
async function deleteFrom(
  msgs: Message[],
  msgId: string,
  inclusive: boolean,
  del: (id: string) => Promise<void>,
): Promise<void> {
  const idx = msgs.findIndex((m) => m.id === msgId)
  if (idx === -1) return
  const tail = msgs.slice(inclusive ? idx : idx + 1)
  for (let i = tail.length - 1; i >= 0; i--) await del(tail[i]!.id)
}

function ActionBtn({
  testId,
  title,
  onClick,
  danger = false,
  done = false,
  children,
}: {
  testId: string
  title: string
  onClick(): void
  danger?: boolean
  done?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      className={`cv-act${danger ? ' danger' : ''}${done ? ' copied' : ''}`}
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** Copy button with ✓ feedback; independent per action row. */
function CopyAction({ text }: { text: string }): JSX.Element {
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onClick = (): void => {
    void copyText(text).then(() => {
      setDone(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setDone(false), 1200)
    })
  }
  return (
    <ActionBtn testId="msg-copy" title={done ? '已复制' : '复制'} onClick={onClick} done={done}>
      {done ? <CheckIcon /> : <CopyIcon />}
    </ActionBtn>
  )
}

/* ── thinking fold ── */

function ThinkingBlock({ msg, wasLive }: { msg: Message; wasLive: boolean }): JSX.Element | null {
  const reasoning = msg.reasoning ?? ''
  const [manual, setManual] = useState(false)
  const [collapsedByUser, setCollapsedByUser] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const endAtRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // auto-expand while streaming, auto-collapse when done (unless user toggled)
  const open = manual ? !collapsedByUser : msg.streaming === true && reasoning.length > 0

  // freeze the elapsed time at the moment the stream ends (live-watched only;
  // history-loaded messages have no trustworthy think duration)
  if (!msg.streaming && wasLive && endAtRef.current === null) endAtRef.current = Date.now()

  useEffect(() => {
    if (!msg.streaming) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [msg.streaming])

  // stream-follow the reasoning text while the fold is open
  useEffect(() => {
    const el = scrollRef.current
    if (el && open && msg.streaming) el.scrollTop = el.scrollHeight
  }, [reasoning.length, open, msg.streaming])

  const end = msg.streaming ? now : endAtRef.current
  const secs = end !== null ? Math.max(1, Math.round((end - msg.createdAt) / 1000)) : 0
  const label = msg.streaming ? `思考中… ${secs}s` : secs > 0 ? `已思考 ${secs}s` : '已思考'

  const toggle = (): void => {
    setManual(true)
    setCollapsedByUser(open)
  }

  return (
    <div className={`think${open ? ' open' : ''}`}>
      <button
        type="button"
        className={`think-toggle${msg.streaming ? ' live' : ''}`}
        data-testid="think-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronIcon />
        <span className="brain" aria-hidden="true">💭</span>
        <span className="think-label">{label}</span>
      </button>
      <div className="think-body" data-testid="think-body">
        <div className="think-body-clip">
          <div className="think-scroll" ref={scrollRef}>
            {reasoning}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── message rows ── */

function UserRow({ msg, messages }: { msg: Message; messages: Message[] }): JSX.Element {
  const { deleteMessageById, sendMessage } = useStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) taRef.current?.focus()
  }, [editing])
  useEffect(() => {
    if (editing) {
      const el = taRef.current
      if (el) {
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 220)}px`
      }
    }
  }, [draft, editing])

  const confirmEdit = (): void => {
    const text = draft.trim()
    setEditing(false)
    if (!text || text === msg.content) return
    void (async () => {
      await deleteFrom(messages, msg.id, true, deleteMessageById)
      await sendMessage(text)
    })()
  }

  if (editing) {
    return (
      <div className="cv-msg user" data-testid="msg-row" data-role="user">
        <div className="cv-edit">
          <textarea
            ref={taRef}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                confirmEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
            }}
          />
          <div className="cv-edit-row">
            <button type="button" className="cv-edit-btn" onClick={() => setEditing(false)}>
              取消
            </button>
            <button type="button" className="cv-edit-btn primary" onClick={confirmEdit}>
              发送
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cv-msg user" data-testid="msg-row" data-role="user">
      <div className="cv-bubble">{msg.content}</div>
      <div className="cv-acts">
        <CopyAction text={msg.content} />
        <ActionBtn
          testId="msg-edit"
          title="编辑并重发"
          onClick={() => {
            setDraft(msg.content)
            setEditing(true)
          }}
        >
          <PencilIcon />
        </ActionBtn>
        <ActionBtn testId="msg-del" title="删除" danger onClick={() => void deleteMessageById(msg.id)}>
          <TrashIcon />
        </ActionBtn>
      </div>
    </div>
  )
}

function AssistantRow({
  msg,
  isLastAssistant,
  messages,
  wasLive,
}: {
  msg: Message
  isLastAssistant: boolean
  messages: Message[]
  wasLive: boolean
}): JSX.Element {
  const { deleteMessageById, regenerateLast } = useStore()
  const streaming = msg.streaming === true

  const onRegen = (): void => {
    void (async () => {
      if (!isLastAssistant) await deleteFrom(messages, msg.id, false, deleteMessageById)
      await regenerateLast()
    })()
  }

  return (
    <div className="cv-msg assistant" data-testid="msg-row" data-role="assistant">
      <div className="cv-a">
        <div className="cv-avatar" aria-hidden="true">
          <BoltIcon />
        </div>
        <div className="cv-a-body">
          {msg.reasoning ? <ThinkingBlock msg={msg} wasLive={wasLive} /> : null}
          <div className="cv-md" data-testid="stream-content">
            {msg.content ? (
              <Markdown text={msg.content} streaming={streaming} />
            ) : streaming ? (
              <span className="cv-cursor-placeholder" />
            ) : null}
          </div>
          {msg.error ? (
            <div className="cv-err">
              <span className="msg">{msg.error}</span>
              <button type="button" className="cv-err-retry" onClick={() => void regenerateLast()}>
                重试
              </button>
            </div>
          ) : null}
          <div className="cv-acts">
            <CopyAction text={msg.content} />
            <ActionBtn testId="msg-regen" title="重新生成" onClick={onRegen}>
              <RefreshIcon />
            </ActionBtn>
            <ActionBtn testId="msg-del" title="删除" danger onClick={() => void deleteMessageById(msg.id)}>
              <TrashIcon />
            </ActionBtn>
          </div>
          {!streaming && (msg.tokensIn || msg.tokensOut) ? (
            <div className="cv-usage">
              ↑{msg.tokensIn ?? 0} ↓{msg.tokensOut ?? 0} tok
              {msg.model ? <span style={{ opacity: 0.7 }}> · {msg.model}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function NoticeRow({ msg }: { msg: Message }): JSX.Element {
  return (
    <div className="cv-notice" data-testid="msg-row" data-role="notice" role="status">
      <span className="zap">
        <BoltIcon />
      </span>
      <span>{msg.content}</span>
    </div>
  )
}

/* ── empty state ── */

const EXAMPLE_PROMPTS = [
  { icon: '🤖', title: '认识 RoboJex', text: '介绍一下你自己：你是谁，能帮我做些什么？' },
  { icon: '💡', title: '解释概念', text: '用通俗易懂的方式解释 React Hooks 的原理，并给出代码示例' },
  { icon: '🧭', title: '规划任务', text: '帮我制定一个两周学习计划，主题是 Rust 系统编程' },
  { icon: '⚡', title: '写点代码', text: '用 Python 写一个快速排序，并逐行讲解实现思路' },
]

function EmptyState({ onPick }: { onPick(text: string): void }): JSX.Element {
  return (
    <div className="cv-empty">
      <div className="cv-orb-zone">
        <div className="cv-orb-glow" />
        <div className="cv-orb">
          <BoltIcon />
        </div>
      </div>
      <h1 className="cv-empty-title">有什么可以帮您？</h1>
      <p className="cv-empty-sub">与 RoboJex 对话，或让它在 Agent 模式下自主工作</p>
      <div className="cv-prompts">
        {EXAMPLE_PROMPTS.map((p, i) => (
          <button
            key={p.title}
            type="button"
            className="cv-prompt"
            data-testid="empty-prompt"
            style={{ animationDelay: `${120 + i * 90}ms` } as CSSProperties}
            onClick={() => onPick(p.text)}
          >
            <span className="cv-prompt-head">
              <span className="ico" aria-hidden="true">{p.icon}</span>
              {p.title}
            </span>
            <span className="cv-prompt-text">{p.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── ChatView ── */

export function ChatView() {
  const { state, sendMessage, regenerateLast } = useStore()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [jump, setJump] = useState(false)

  const messages = state.messages
  // remember which assistant messages were observed streaming (for the
  // “已思考 Xs” freeze — history loads have no reliable think duration)
  const seenStreaming = useRef<Set<string>>(new Set())
  for (const m of messages) if (m.streaming) seenStreaming.current.add(m.id)
  const wasLive = (id: string): boolean => seenStreaming.current.has(id)
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i].id
    return null
  }, [messages])

  const last = messages.length > 0 ? messages[messages.length - 1] : undefined
  const sig = `${messages.length}:${last?.content.length ?? 0}:${last?.reasoning?.length ?? 0}:${last?.streaming ?? false}`

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    stick.current = near
    setJump((prev) => (prev === !near ? prev : !near))
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [sig])

  // switching conversations snaps to the bottom and re-arms stickiness
  useEffect(() => {
    stick.current = true
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setJump(false)
  }, [state.activeConvId])

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stick.current = true
    setJump(false)
  }

  const streamErr = state.stream.status === 'error' ? state.stream.error : undefined

  return (
    <div className="cv">
      <div className="cv-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <EmptyState onPick={(t) => void sendMessage(t)} />
        ) : (
          <div className="cv-inner">
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserRow key={m.id} msg={m} messages={messages} />
              ) : m.role === 'assistant' ? (
                <AssistantRow
                  key={m.id}
                  msg={m}
                  messages={messages}
                  isLastAssistant={m.id === lastAssistantId}
                  wasLive={wasLive(m.id)}
                />
              ) : (
                <NoticeRow key={m.id} msg={m} />
              ),
            )}
          </div>
        )}
      </div>

      {jump && messages.length > 0 ? (
        <button type="button" className="cv-jump" onClick={scrollToBottom} aria-label="回到底部">
          <span className="arrow">↓</span> 回到底部
        </button>
      ) : null}

      <div className="cv-inputzone">
        {streamErr ? (
          <div className="cv-stream-err">
            <span aria-hidden="true">⚠</span>
            <span className="msg">{streamErr}</span>
            <button type="button" className="cv-err-retry" onClick={() => void regenerateLast()}>
              重试
            </button>
          </div>
        ) : null}
        <InputBar />
      </div>
    </div>
  )
}
