// packages/web/src/state/store.tsx — zero-library store: useReducer + Context.
// Two state domains in one reducer:
//  1. jex agent state — frame-driven from the core WS (hello/chat_out/tasks/
//     cycle/mode/budget/gear), plus the legacy transcript for Activity.
//  2. chat state — conversations + messages persisted via REST, live deltas
//     via SSE (/api/chat/stream). Streaming writes land on the last assistant
//     message with `streaming: true`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { connectEvents, eventsUrl } from './connection'
import type { ConnectionHandle } from './connection'
import * as api from './api'
import type { StreamHandle } from './api'
import { setThemePref, themeSnapshot } from './theme'
import type {
  Budget,
  ChatMsg,
  ChatStreamEvent,
  Conversation,
  GearDef,
  GearId,
  HudNotice,
  Message,
  Mode,
  ServerFrame,
  StreamState,
  Task,
  TranscriptItem,
} from './types'
import { ingestFrame } from '../views/activityModel'
import type { ActivityItem } from './types'

export interface WebState {
  /* connection + jex agent */
  conn: 'connecting' | 'live' | 'reconnecting'
  version: string
  tasks: Task[]
  selectedTaskId: string | null
  budget: Budget | null
  mode: Mode
  mission: string
  rubric: string
  memory: string
  transcript: TranscriptItem[]
  waiting: boolean
  clockOffset: number
  lastHud: HudNotice | null

  /* autonomy gears */
  gear: GearId
  gears: GearDef[]
  gearAppliedTickMs: number

  /* conversations + chat */
  conversations: Conversation[]
  activeConvId: string | null
  /** messages of the ACTIVE conversation only; switched via loadConversation. */
  messages: Message[]
  stream: StreamState
  /** preferred chat model (persisted). */
  model: string
  models: string[]
  /** true until the first conversations fetch resolves. */
  convsLoading: boolean
}

type Action =
  | { type: 'conn'; conn: WebState['conn'] }
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'select-task'; id: string | null }
  | { type: 'local-msg'; text: string }
  | { type: 'sent' }
  | { type: 'reply-timeout' }
  /* gears */
  | { type: 'gear-loaded'; gear: GearId; gears: GearDef[]; appliedTickMs: number }
  | { type: 'gear-set'; gear: GearId; appliedTickMs?: number }
  /* conversations */
  | { type: 'convs-loading' }
  | { type: 'convs-loaded'; conversations: Conversation[] }
  | { type: 'conv-created'; conv: Conversation }
  | { type: 'conv-updated'; conv: Conversation }
  | { type: 'conv-deleted'; id: string }
  | { type: 'conv-selected'; id: string | null; messages: Message[] }
  | { type: 'msg-deleted'; id: string }
  | { type: 'chat-notice'; text: string }
  /* streaming */
  | { type: 'stream-start'; convId: string }
  | { type: 'stream-meta'; convId: string; userMsgId: string; assistantMsgId: string; model: string }
  | { type: 'stream-delta'; convId: string; field: 'reasoning' | 'content'; delta: string }
  | { type: 'stream-usage'; convId: string; tokensIn: number; tokensOut: number }
  | { type: 'stream-done'; convId: string; title?: string }
  | { type: 'stream-error'; convId: string; message: string }
  | { type: 'stream-stopping' }
  /* models */
  | { type: 'models-loaded'; models: string[] }
  | { type: 'model-set'; model: string }

const MODEL_KEY = 'robojex-model'

function readModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) || 'deepseek-v4-flash'
  } catch {
    return 'deepseek-v4-flash'
  }
}

const initialState: WebState = {
  conn: 'connecting',
  version: '',
  tasks: [],
  selectedTaskId: null,
  budget: null,
  mode: 'observe',
  mission: '',
  rubric: '',
  memory: '',
  transcript: [],
  waiting: false,
  clockOffset: 0,
  lastHud: null,
  gear: 'balanced',
  gears: [],
  gearAppliedTickMs: 60_000,
  conversations: [],
  activeConvId: null,
  messages: [],
  stream: { status: 'idle', convId: null, startedAt: 0 },
  model: readModel(),
  models: [],
  convsLoading: true,
}

// Transcript/message ids only need uniqueness within a session; StrictMode's
// double reducer invocation burns a couple of ids harmlessly.
let seq = 0
const nextId = (): string => `local-${Date.now().toString(36)}-${++seq}`

function chatToItem(m: ChatMsg): TranscriptItem {
  return { kind: 'msg', id: seq++, from: m.from, text: m.text, ts: m.ts }
}

/** Map a task status string to a dot/toast tone vocabulary. Core statuses
 * are exactly todo/running/done/blocked (board v2); 'blocked' renders as the
 * failed/red tone. */
export function statusTone(status: string): 'done' | 'running' | 'pending' | 'failed' {
  const s = status.toLowerCase()
  if (s.includes('done') || s.includes('complete') || s.includes('success')) return 'done'
  if (s.includes('run') || s.includes('progress') || s.includes('active')) return 'running'
  if (
    s.includes('fail') ||
    s.includes('error') ||
    s.includes('abort') ||
    s.includes('cancel') ||
    s.includes('block')
  )
    return 'failed'
  return 'pending'
}

function tasksToToasts(prev: Task[], next: Task[]): TranscriptItem[] {
  const prevById = new Map(prev.map((t) => [t.id, t]))
  const toasts: TranscriptItem[] = []
  for (const t of next) {
    const old = prevById.get(t.id)
    if (!old) {
      toasts.push({
        kind: 'toast',
        id: seq++,
        tone: 'info',
        text: `new task · ${t.title}`,
        ts: Date.now(),
      })
      continue
    }
    if (old.status !== t.status) {
      toasts.push({
        kind: 'toast',
        id: seq++,
        tone: statusTone(t.status) === 'failed' ? 'error' : statusTone(t.status) === 'done' ? 'success' : 'info',
        text: `${t.title} · ${old.status} → ${t.status}`,
        ts: Date.now(),
      })
    }
  }
  return toasts
}

function patchConv(state: WebState, id: string, patch: Partial<Conversation>): WebState {
  return {
    ...state,
    conversations: state.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }
}

/** Bump a conversation to the top of its sort group (preview + updatedAt). */
function reducer(state: WebState, action: Action): WebState {
  switch (action.type) {
    case 'conn':
      return state.conn === action.conn ? state : { ...state, conn: action.conn }
    case 'select-task':
      return { ...state, selectedTaskId: action.id }
    case 'local-msg':
      return {
        ...state,
        transcript: [...state.transcript, chatToItem({ from: 'system', ts: Date.now(), text: action.text })],
      }
    case 'sent':
      return { ...state, waiting: true }
    case 'reply-timeout':
      return state.waiting ? { ...state, waiting: false } : state

    /* gears */
    case 'gear-loaded':
      return { ...state, gear: action.gear, gears: action.gears, gearAppliedTickMs: action.appliedTickMs }
    case 'gear-set':
      return {
        ...state,
        gear: action.gear,
        gearAppliedTickMs: action.appliedTickMs ?? state.gearAppliedTickMs,
      }

    /* conversations */
    case 'convs-loading':
      return state.convsLoading ? state : { ...state, convsLoading: true }
    case 'convs-loaded':
      return { ...state, conversations: action.conversations, convsLoading: false }
    case 'conv-created':
      return { ...state, conversations: [action.conv, ...state.conversations] }
    case 'conv-updated':
      return patchConv(state, action.conv.id, action.conv)
    case 'conv-deleted': {
      const conversations = state.conversations.filter((c) => c.id !== action.id)
      const activeGone = state.activeConvId === action.id
      return {
        ...state,
        conversations,
        activeConvId: activeGone ? null : state.activeConvId,
        messages: activeGone ? [] : state.messages,
      }
    }
    case 'conv-selected':
      return { ...state, activeConvId: action.id, messages: action.messages }
    case 'msg-deleted':
      return { ...state, messages: state.messages.filter((m) => m.id !== action.id) }
    case 'chat-notice': {
      if (!state.activeConvId) return state
      const notice: Message = {
        id: nextId(),
        convId: state.activeConvId,
        role: 'notice',
        content: action.text,
        createdAt: Date.now(),
      }
      return { ...state, messages: [...state.messages, notice] }
    }

    /* streaming */
    case 'stream-start':
      return {
        ...state,
        stream: { status: 'streaming', convId: action.convId, startedAt: Date.now() },
      }
    case 'stream-meta': {
      if (state.activeConvId !== action.convId) return state
      const messages = [...state.messages]
      // reconcile the optimistic user message id with the server's
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          if (action.userMsgId) messages[i] = { ...messages[i], id: action.userMsgId }
          break
        }
      }
      messages.push({
        id: action.assistantMsgId,
        convId: action.convId,
        role: 'assistant',
        content: '',
        reasoning: '',
        model: action.model,
        createdAt: Date.now(),
        streaming: true,
      })
      return { ...state, messages }
    }
    case 'stream-delta': {
      if (state.activeConvId !== action.convId) return state
      const messages = [...state.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].streaming) {
          messages[i] = { ...messages[i], [action.field]: (messages[i][action.field] || '') + action.delta }
          break
        }
      }
      return { ...state, messages }
    }
    case 'stream-usage': {
      if (state.activeConvId !== action.convId) return state
      const messages = [...state.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].streaming) {
          messages[i] = { ...messages[i], tokensIn: action.tokensIn, tokensOut: action.tokensOut }
          break
        }
      }
      return { ...state, messages }
    }
    case 'stream-done': {
      if (state.activeConvId !== action.convId) return state
      let conversations = state.conversations
      const conv = state.conversations.find((c) => c.id === action.convId)
      if (conv) {
        const lastMsg = state.messages.filter((m) => m.role !== 'notice').slice(-1)[0]
        const lastContent = lastMsg?.content || conv.preview
        const finished = state.messages.some((m) => m.streaming)
        conversations = state.conversations.map((c) =>
          c.id === action.convId
            ? {
                ...c,
                updatedAt: Date.now(),
                preview: lastContent.slice(0, 80),
                title: action.title || c.title,
                messageCount: c.messageCount + (finished ? 1 : 0),
              }
            : c,
        )
      }
      return {
        ...state,
        conversations,
        messages: state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        stream: { status: 'idle', convId: null, startedAt: 0 },
      }
    }
    case 'stream-error': {
      if (state.activeConvId !== action.convId) return state
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.streaming ? { ...m, streaming: false, error: action.message } : m,
        ),
        stream: { status: 'error', convId: null, startedAt: 0, error: action.message },
      }
    }
    case 'stream-stopping':
      return { ...state, stream: { ...state.stream, status: 'stopping' } }

    /* models */
    case 'models-loaded':
      return { ...state, models: action.models }
    case 'model-set':
      return { ...state, model: action.model }

    case 'frame':
      return applyFrame(state, action.frame)
  }
}

function applyFrame(state: WebState, frame: ServerFrame): WebState {
  switch (frame.t) {
    case 'hello': {
      const s = frame.state
      return {
        ...state,
        version: s.version,
        tasks: s.tasks,
        budget: s.budget,
        mode: s.mode,
        mission: s.mission,
        rubric: s.rubric,
        memory: s.memory,
        gear: s.gear ?? state.gear,
        clockOffset: typeof s.now === 'number' ? s.now - Date.now() : 0,
        waiting: false,
        // Full rebuild on (re)connect — the ring replays recent history.
        transcript: s.chat.map(chatToItem),
      }
    }
    case 'chat_out': {
      const item = chatToItem({ from: frame.from, ts: frame.ts, text: frame.text })
      return {
        ...state,
        transcript: [...state.transcript, item],
        waiting: frame.from === 'jex' ? false : state.waiting,
      }
    }
    case 'tasks': {
      const toasts = tasksToToasts(state.tasks, frame.tasks)
      return {
        ...state,
        tasks: frame.tasks,
        transcript: toasts.length > 0 ? [...state.transcript, ...toasts] : state.transcript,
      }
    }
    case 'cycle':
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            kind: 'cycle',
            id: seq++,
            wake: frame.wake,
            cost: frame.cost,
            actions: frame.actions,
            ts: Date.now(),
          },
        ],
      }
    case 'hud':
      return { ...state, lastHud: { kind: frame.kind, taskId: frame.taskId, ts: frame.ts } }
    case 'mode':
      return state.mode === frame.mode ? state : { ...state, mode: frame.mode }
    case 'budget': {
      if (!state.budget) return state // no baseline yet; wait for hello
      if (frame.budget) return { ...state, budget: frame.budget }
      return state.budget.line === frame.line
        ? state
        : { ...state, budget: { ...state.budget, line: frame.line } }
    }
    case 'gear':
      return state.gear === frame.gear ? state : { ...state, gear: frame.gear }
  }
}

export interface StoreApi {
  state: WebState
  activityItems: ActivityItem[]

  /* jex agent */
  selectTask(id: string | null): void
  /** legacy WS chat into the jex loop (agent orchestration channel). */
  sendAgentChat(text: string): void
  setMode(mode: Mode): void
  appendMission(text: string): void
  /** Execute a /command; returns false when the text is not a command. */
  runCommand(text: string): boolean

  /* gears */
  changeGear(gear: GearId): Promise<void>
  refreshGear(): Promise<void>

  /* conversations */
  refreshConversations(): Promise<void>
  newConversation(): Promise<Conversation | null>
  selectConversation(id: string | null): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  togglePinConversation(id: string, pinned: boolean): Promise<void>
  deleteConversationById(id: string): Promise<void>
  deleteMessageById(id: string): Promise<void>

  /* streaming chat */
  sendMessage(text: string): Promise<void>
  stopStream(): void
  regenerateLast(): Promise<void>

  /* models */
  refreshModels(): Promise<void>
  setModel(model: string): void
}

const StoreContext = createContext<StoreApi | null>(null)

const REPLY_TIMEOUT_MS = 30_000

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const [activityItems, setActivityItems] = useState<ActivityItem[]>([])
  const activityRef = useRef(activityItems)
  activityRef.current = activityItems

  const connRef = useRef<ConnectionHandle | null>(null)
  const streamRef = useRef<StreamHandle | null>(null)

  /* ── boot: WS + initial REST loads ── */
  const loadedOnce = useRef(false)
  useEffect(() => {
    connRef.current = connectEvents({
      url: eventsUrl(),
      onFrame: (frame) => {
        dispatch({ type: 'frame', frame })
        setActivityItems((prev) => ingestFrame(frame as unknown as Record<string, unknown>, prev))
        // inline jex notices inside the open conversation
        const f = frame as { t: string; from?: string; text?: string }
        if (f.t === 'chat_out' && f.from === 'jex' && f.text) {
          dispatch({ type: 'chat-notice', text: `jex · ${f.text}` })
        }
      },
      onStatus: (conn) => {
        dispatch({ type: 'conn', conn })
        if (conn === 'live' && !loadedOnce.current) {
          loadedOnce.current = true
          void api.getGear().then(
            (g) => dispatch({ type: 'gear-loaded', gear: g.gear, gears: g.gears, appliedTickMs: g.appliedTickMs }),
            () => undefined,
          )
          void api.listConversations().then(
            (convs) => dispatch({ type: 'convs-loaded', conversations: convs }),
            () => dispatch({ type: 'convs-loaded', conversations: [] }),
          )
        }
      },
    })
    return () => {
      connRef.current?.close()
      connRef.current = null
    }
  }, [])

  // Release the input lock when core stays silent for 30s.
  const { waiting } = state
  useEffect(() => {
    if (!waiting) return
    const timer = window.setTimeout(() => dispatch({ type: 'reply-timeout' }), REPLY_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [waiting])

  const localMsg = useCallback((text: string) => dispatch({ type: 'local-msg', text }), [])

  /* ── jex agent ops (legacy channel) ── */
  const sendAgentChat = useCallback(
    (text: string) => {
      const body = text.trim()
      if (!body) return
      if (connRef.current?.sendChat(body)) {
        dispatch({ type: 'sent' })
        return
      }
      dispatch({ type: 'sent' })
      void fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      }).then(
        (res) => {
          if (!res.ok) localMsg(`send failed (HTTP ${res.status})`)
        },
        (err: unknown) => {
          localMsg(`send failed (${err instanceof Error ? err.message : String(err)})`)
        },
      )
    },
    [localMsg],
  )

  const setMode = useCallback(
    (mode: Mode) => {
      void fetch('/api/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      }).then(
        (res) => {
          if (res.ok) localMsg(`mode → ${mode}`)
          else localMsg(`mode change rejected (HTTP ${res.status})`)
        },
        (err: unknown) => {
          localMsg(`mode change failed (${err instanceof Error ? err.message : String(err)})`)
        },
      )
    },
    [localMsg],
  )

  const appendMission = useCallback(
    (text: string) => {
      void fetch('/api/mission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then(
        (res) => {
          if (!res.ok) localMsg(`mission append rejected (HTTP ${res.status})`)
        },
        (err: unknown) => {
          localMsg(`mission append failed (${err instanceof Error ? err.message : String(err)})`)
        },
      )
    },
    [localMsg],
  )

  /* ── gears ── */
  const refreshGear = useCallback(async () => {
    try {
      const g = await api.getGear()
      dispatch({ type: 'gear-loaded', gear: g.gear, gears: g.gears, appliedTickMs: g.appliedTickMs })
    } catch {
      // backend without gear support — leave defaults
    }
  }, [])

  const changeGear = useCallback(
    async (gear: GearId) => {
      dispatch({ type: 'gear-set', gear })
      try {
        const g = await api.setGear(gear)
        dispatch({ type: 'gear-loaded', gear: g.gear, gears: g.gears, appliedTickMs: g.appliedTickMs })
        dispatch({ type: 'chat-notice', text: `挡位切换 → ${g.gears.find((x) => x.id === gear)?.name ?? gear}` })
      } catch (err) {
        localMsg(`gear change failed (${err instanceof Error ? err.message : String(err)})`)
        void refreshGear()
      }
    },
    [localMsg, refreshGear],
  )

  /* ── conversations ── */
  const refreshConversations = useCallback(async () => {
    try {
      const convs = await api.listConversations()
      dispatch({ type: 'convs-loaded', conversations: convs })
    } catch {
      dispatch({ type: 'convs-loaded', conversations: [] })
    }
  }, [])

  const newConversation = useCallback(async () => {
    try {
      const conv = await api.createConversation()
      dispatch({ type: 'conv-created', conv })
      dispatch({ type: 'conv-selected', id: conv.id, messages: [] })
      return conv
    } catch (err) {
      localMsg(`new conversation failed (${err instanceof Error ? err.message : String(err)})`)
      return null
    }
  }, [localMsg])

  const selectConversation = useCallback(async (id: string | null) => {
    if (id === null) {
      dispatch({ type: 'conv-selected', id: null, messages: [] })
      return
    }
    // optimistic clear, then load
    dispatch({ type: 'conv-selected', id, messages: [] })
    try {
      const messages = await api.listMessages(id)
      // ignore stale loads after another switch
      if (stateRef.current.activeConvId === id) {
        dispatch({ type: 'conv-selected', id, messages })
      }
    } catch (err) {
      localMsg(`load messages failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }, [localMsg])

  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      const conv = await api.updateConversation(id, { title })
      dispatch({ type: 'conv-updated', conv })
    } catch (err) {
      localMsg(`rename failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }, [localMsg])

  const togglePinConversation = useCallback(async (id: string, pinned: boolean) => {
    try {
      const conv = await api.updateConversation(id, { pinned })
      dispatch({ type: 'conv-updated', conv })
    } catch (err) {
      localMsg(`pin failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }, [localMsg])

  const deleteConversationById = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id)
        dispatch({ type: 'conv-deleted', id })
      } catch (err) {
        localMsg(`delete failed (${err instanceof Error ? err.message : String(err)})`)
      }
    },
    [localMsg],
  )

  const deleteMessageById = useCallback(async (id: string) => {
    // optimistic
    dispatch({ type: 'msg-deleted', id })
    try {
      await api.deleteMessage(id)
    } catch (err) {
      localMsg(`delete message failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }, [localMsg])

  /* ── streaming chat ── */
  const consumeStream = useCallback((convId: string, ev: ChatStreamEvent) => {
    switch (ev.type) {
      case 'meta':
        dispatch({ type: 'stream-meta', convId, userMsgId: ev.userMsgId, assistantMsgId: ev.assistantMsgId, model: ev.model })
        break
      case 'reasoning':
        dispatch({ type: 'stream-delta', convId, field: 'reasoning', delta: ev.delta })
        break
      case 'content':
        dispatch({ type: 'stream-delta', convId, field: 'content', delta: ev.delta })
        break
      case 'usage':
        dispatch({ type: 'stream-usage', convId, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut })
        break
      case 'title':
        dispatch({ type: 'stream-done', convId, title: ev.title })
        break
      case 'done':
        dispatch({ type: 'stream-done', convId })
        break
      case 'error':
        dispatch({ type: 'stream-error', convId, message: ev.message })
        break
    }
  }, [])

  const sendMessage = useCallback(
    async (text: string) => {
      const body = text.trim()
      if (!body || stateRef.current.stream.status === 'streaming') return
      let convId = stateRef.current.activeConvId
      if (!convId) {
        const conv = await newConversation()
        if (!conv) return
        convId = conv.id
      }
      // optimistic user message
      dispatch({
        type: 'conv-selected',
        id: convId,
        messages: [
          ...stateRef.current.messages,
          { id: nextId(), convId, role: 'user', content: body, createdAt: Date.now() },
        ],
      })
      dispatch({ type: 'stream-start', convId })
      const handle = api.streamChat(
        { conversationId: convId, text: body, model: stateRef.current.model },
        (ev) => consumeStream(convId, ev),
      )
      streamRef.current = handle
      await handle.done
      streamRef.current = null
    },
    [consumeStream, newConversation],
  )

  const stopStream = useCallback(() => {
    if (stateRef.current.stream.status !== 'streaming') return
    dispatch({ type: 'stream-stopping' })
    streamRef.current?.abort()
  }, [])

  const regenerateLast = useCallback(async () => {
    const convId = stateRef.current.activeConvId
    if (!convId || stateRef.current.stream.status === 'streaming') return
    // optimistic: drop trailing assistant messages
    const msgs = [...stateRef.current.messages]
    while (msgs.length > 0 && msgs[msgs.length - 1].role !== 'user') msgs.pop()
    dispatch({ type: 'conv-selected', id: convId, messages: msgs })
    dispatch({ type: 'stream-start', convId })
    const handle = api.regenerate(convId, (ev) => consumeStream(convId, ev))
    streamRef.current = handle
    await handle.done
    streamRef.current = null
  }, [consumeStream])

  /* ── models ── */
  const refreshModels = useCallback(async () => {
    try {
      const models = await api.listModels()
      dispatch({ type: 'models-loaded', models })
    } catch {
      // keep empty list; model input stays free-form
    }
  }, [])

  const setModel = useCallback((model: string) => {
    try {
      localStorage.setItem(MODEL_KEY, model)
    } catch {
      // best-effort
    }
    dispatch({ type: 'model-set', model })
  }, [])

  /* ── slash commands ── */
  const runCommand = useCallback(
    (raw: string): boolean => {
      const text = raw.trim()
      if (!text.startsWith('/')) return false
      const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text)
      if (!m) {
        localMsg(`unknown command · ${text}`)
        return true
      }
      const [, name, arg = ''] = m
      switch (name) {
        case 'mode': {
          const mode = arg.trim() as Mode
          if (mode === 'observe' || mode === 'assist' || mode === 'full') setMode(mode)
          else localMsg('usage: /mode observe|assist|full')
          return true
        }
        case 'gear': {
          const gear = arg.trim() as GearId
          if (gear === 'dormant' || gear === 'eco' || gear === 'balanced' || gear === 'focused' || gear === 'turbo') {
            void changeGear(gear)
          } else {
            const cur = stateRef.current.gear
            localMsg(
              `current gear: ${cur}\nusage: /gear dormant|eco|balanced|focused|turbo\n0=休眠 1=省电 2=均衡 3=专注 4=狂暴`,
            )
          }
          return true
        }
        case 'model': {
          const model = arg.trim()
          if (model) setModel(model)
          else localMsg(`current model: ${stateRef.current.model}\nusage: /model <name> (see /models)`)
          return true
        }
        case 'models':
          void refreshModels().then(() => {
            localMsg(stateRef.current.models.join('\n') || 'no models — check settings')
          })
          return true
        case 'theme': {
          const pref = arg.trim() as 'light' | 'dark' | 'system'
          if (pref === 'light' || pref === 'dark' || pref === 'system') {
            setThemePref(pref)
            localMsg(`theme → ${themeSnapshot().resolved}`)
          } else localMsg('usage: /theme light|dark|system')
          return true
        }
        case 'jex': {
          const body = arg.trim()
          if (!body) localMsg('usage: /jex <text> — send to the jex orchestration loop')
          else if (!stateRef.current.activeConvId) {
            // give the jex replies a home: open a conversation first
            void newConversation().then((conv) => {
              if (conv) sendAgentChat(body)
            })
          } else sendAgentChat(body)
          return true
        }
        case 'tasks': {
          const tasks = stateRef.current.tasks
          localMsg(
            tasks.length === 0
              ? 'task board is empty'
              : tasks.map((t) => `- [${t.status}] ${t.title} (${t.id})`).join('\n'),
          )
          return true
        }
        case 'mission': {
          const body = arg.trim()
          if (!body) localMsg('usage: /mission <text> — appends to MISSION.md')
          else appendMission(body)
          return true
        }
        case 'budget': {
          const b = stateRef.current.budget
          localMsg(
            b
              ? `${b.line}\nspent today: ${b.spentToday} / ${b.dailyTokens} tokens`
              : 'budget unknown — waiting for core state',
          )
          return true
        }
        case 'help':
          localMsg(
            [
              '/gear dormant|eco|balanced|focused|turbo — 自主挡位切换',
              '/model <name> · /models — 选择/列出模型',
              '/theme light|dark|system — 主题',
              '/jex <text> — 发给 jex 编排循环（自主任务）',
              '/mode observe|assist|full — takeover 模式',
              '/tasks — 任务板 · /mission <text> — 追加使命',
              '/budget — 今日 token 预算 · /help — 本列表',
            ].join('\n'),
          )
          return true
        default:
          localMsg(`unknown command · /${name} — try /help`)
          return true
      }
    },
    [appendMission, changeGear, localMsg, newConversation, refreshModels, sendAgentChat, setMode, setModel],
  )

  const selectTask = useCallback((id: string | null) => dispatch({ type: 'select-task', id }), [])

  const apiValue = useMemo<StoreApi>(
    () => ({
      state,
      activityItems,
      selectTask,
      sendAgentChat,
      setMode,
      appendMission,
      runCommand,
      changeGear,
      refreshGear,
      refreshConversations,
      newConversation,
      selectConversation,
      renameConversation,
      togglePinConversation,
      deleteConversationById,
      deleteMessageById,
      sendMessage,
      stopStream,
      regenerateLast,
      refreshModels,
      setModel,
    }),
    [
      state,
      activityItems,
      selectTask,
      sendAgentChat,
      setMode,
      appendMission,
      runCommand,
      changeGear,
      refreshGear,
      refreshConversations,
      newConversation,
      selectConversation,
      renameConversation,
      togglePinConversation,
      deleteConversationById,
      deleteMessageById,
      sendMessage,
      stopStream,
      regenerateLast,
      refreshModels,
      setModel,
    ],
  )

  return <StoreContext.Provider value={apiValue}>{children}</StoreContext.Provider>
}

export function useStore(): StoreApi {
  const api = useContext(StoreContext)
  if (!api) throw new Error('useStore requires <StoreProvider>')
  return api
}

/** Re-export ActivityItem type for convenience. */
export type { ActivityItem }
