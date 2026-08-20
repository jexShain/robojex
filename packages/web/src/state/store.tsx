// packages/web/src/state/store.tsx — zero-library store: useReducer + Context.
// State is frame-driven: every WS frame from core maps to one reducer branch
// (hello/chat_out/tasks/cycle/mode/budget per the frozen contract). A `hello`
// after reconnect performs the full state rebuild.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react'
import type { ReactNode } from 'react'
import { connectEvents, eventsUrl } from './connection'
import type { ConnectionHandle } from './connection'
import type { Budget, ChatMsg, Mode, ServerFrame, Task, TranscriptItem } from './types'

export interface WebState {
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
  /** Input locked between send and the next jex chat_out (or 30s timeout). */
  waiting: boolean
}

type Action =
  | { type: 'conn'; conn: WebState['conn'] }
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'select-task'; id: string | null }
  | { type: 'local-msg'; text: string }
  | { type: 'sent' }
  | { type: 'reply-timeout' }

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
}

// Transcript ids only need uniqueness within a session; StrictMode's double
// reducer invocation burns a couple of ids harmlessly.
let seq = 0
const nextId = (): number => ++seq

function chatToItem(m: ChatMsg): TranscriptItem {
  return { kind: 'msg', id: nextId(), from: m.from, text: m.text, ts: m.ts }
}

/** Map a task status string to a dot/toast tone vocabulary. */
export function statusTone(status: string): 'done' | 'running' | 'pending' | 'failed' {
  const s = status.toLowerCase()
  if (s.includes('done') || s.includes('complete') || s.includes('success')) return 'done'
  if (s.includes('run') || s.includes('progress') || s.includes('active')) return 'running'
  if (s.includes('fail') || s.includes('error') || s.includes('abort') || s.includes('cancel'))
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
        id: nextId(),
        tone: 'info',
        text: `new task · ${t.title}`,
        ts: Date.now(),
      })
      continue
    }
    if (old.status !== t.status) {
      toasts.push({
        kind: 'toast',
        id: nextId(),
        tone: statusTone(t.status) === 'failed' ? 'error' : statusTone(t.status) === 'done' ? 'success' : 'info',
        text: `${t.title} · ${old.status} → ${t.status}`,
        ts: Date.now(),
      })
    }
  }
  return toasts
}

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
            id: nextId(),
            wake: frame.wake,
            cost: frame.cost,
            actions: frame.actions,
            ts: Date.now(),
          },
        ],
      }
    case 'mode':
      return state.mode === frame.mode ? state : { ...state, mode: frame.mode }
    case 'budget': {
      if (!state.budget) return state // no baseline yet; wait for hello
      return state.budget.line === frame.line
        ? state
        : { ...state, budget: { ...state.budget, line: frame.line } }
    }
  }
}

export interface StoreApi {
  state: WebState
  selectTask(id: string | null): void
  sendChat(text: string): void
  setMode(mode: Mode): void
  appendMission(text: string): void
  /** Execute a /command; returns false when the text is not a command. */
  runCommand(text: string): boolean
}

const StoreContext = createContext<StoreApi | null>(null)

const REPLY_TIMEOUT_MS = 30_000

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const connRef = useRef<ConnectionHandle | null>(null)
  useEffect(() => {
    connRef.current = connectEvents({
      url: eventsUrl(),
      onFrame: (frame) => dispatch({ type: 'frame', frame }),
      onStatus: (conn) => dispatch({ type: 'conn', conn }),
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

  const sendChat = useCallback((text: string) => {
    const body = text.trim()
    if (!body) return
    // Prefer the live socket (server broadcasts the user chat_out back);
    // fall back to the HTTP endpoint when the socket is down.
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
  }, [localMsg])

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
              '/mode observe|assist|full — switch takeover mode',
              '/tasks — list the task board',
              '/mission <text> — append to MISSION.md',
              '/budget — show today’s token budget',
              '/help — this list',
            ].join('\n'),
          )
          return true
        default:
          localMsg(`unknown command · /${name} — try /help`)
          return true
      }
    },
    [appendMission, localMsg, setMode],
  )

  const selectTask = useCallback((id: string | null) => dispatch({ type: 'select-task', id }), [])

  const api = useMemo<StoreApi>(
    () => ({ state, selectTask, sendChat, setMode, appendMission, runCommand }),
    [state, selectTask, sendChat, setMode, appendMission, runCommand],
  )

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>
}

export function useStore(): StoreApi {
  const api = useContext(StoreContext)
  if (!api) throw new Error('useStore requires <StoreProvider>')
  return api
}
