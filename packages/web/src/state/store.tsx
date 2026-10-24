// packages/web/src/state/store.tsx — zero-library store: useReducer + Context.
// Two state domains in one reducer:
//  1. jex agent state — frame-driven from the core WS (hello/chat_out/tasks/
//     cycle/mode/budget/gear), plus the legacy transcript for Activity.
//  2. chat state — conversations + messages persisted via REST, live deltas
//     via SSE (/api/chat/stream). Streaming writes land on the last assistant
//     message with `streaming: true`.
// /jex round-trips also render into the open conversation as client-only
// timeline cards (kind 'agent-send' / 'agent-notice') — the backend chat ring
// keeps its own transcript, so these are session-local by design. Inbound
// jex briefings (chat_out from:'jex') are routed by routeNotice() into a
// conversation: live card when open, otherwise parked + an unread badge
// (state.unread / state.notices, memory-only) replayed on the next open.

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
import type { DirectMessage, DirectPrefs, StreamHandle } from './api'
import { fill, LANG_EVENT, langSnapshot, setLangPref, translate } from '../i18n/event'
import { setThemePref, themeSnapshot } from './theme'
import { readVoiceReport, speak } from './voice'
import { pushTrayStatus, trayStatusFor } from './desktop'
import { diffTaskTransitions, snapshotStatuses } from './taskTransitions'
import { gearDisplayName } from '../views/gearDefs'
import type {
  Budget,
  ChatMsg,
  ChatStreamEvent,
  Conversation,
  GearDef,
  GearId,
  HudNotice,
  JobInfo,
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
  /** background shell jobs (R84): pushed as deduped WS frames */
  jobs: JobInfo[]

  /* autonomy gears */
  gear: GearId
  gears: GearDef[]
  gearAppliedTickMs: number

  /* conversations + chat */
  conversations: Conversation[]
  activeConvId: string | null
  /** messages of the ACTIVE conversation only; switched via loadConversation. */
  messages: Message[]
  /** per-conversation unread jex-briefing counts. Memory-only by design:
   * nothing persists server-side (briefing cards are session-local), so a
   * refresh legitimately re-zeros every badge. Keyed by conversation id. */
  unread: Record<string, number>
  /** jex briefing cards that arrived while their conversation was closed —
   * replayed into `messages` on the next open (conv-selected loaded), then
   * cleared. Same session-local lifetime as the unread counts. */
  notices: Record<string, Message[]>
  stream: StreamState
  /** preferred chat model (persisted). */
  model: string
  models: string[]
  /** true until the first conversations fetch resolves. */
  convsLoading: boolean
  /** direct-connection prefs (SPEC §1 fallback): localStorage-backed picker
   * for gateway vs browser-direct DeepSeek; gateway stays the default. */
  direct: DirectPrefs
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
  | { type: 'gears-catalog'; gears: GearDef[]; appliedTickMs: number }
  | { type: 'gear-set'; gear: GearId; appliedTickMs?: number }
  /* conversations */
  | { type: 'convs-loading' }
  | { type: 'convs-loaded'; conversations: Conversation[] }
  | { type: 'conv-created'; conv: Conversation }
  | { type: 'conv-updated'; conv: Conversation }
  | { type: 'conv-deleted'; id: string }
  /** `loaded: true` marks the final dispatch after GET /messages resolves —
   * the point where parked briefing cards splice into the timeline. */
  | { type: 'conv-selected'; id: string | null; messages: Message[]; loaded?: boolean }
  | { type: 'msg-deleted'; id: string }
  | { type: 'chat-notice'; text: string }
  /* /jex timeline cards — client-only, never sent to the server */
  | { type: 'agent-msg'; convId: string; kind: 'agent-send' | 'agent-notice'; text: string }
  /** jex briefing (chat_out from:'jex') landing in a routed conversation:
   * live card when open, parked + unread badge when closed. */
  | { type: 'agent-notice'; convId: string; text: string }
  /* streaming */
  | { type: 'stream-start'; convId: string }
  | { type: 'stream-meta'; convId: string; userMsgId: string; assistantMsgId: string; model: string }
  | { type: 'stream-delta'; convId: string; field: 'reasoning' | 'content'; delta: string }
  | { type: 'stream-tool'; convId: string; name: string; args?: string; state: 'running' | 'done'; preview?: string }
  | { type: 'stream-usage'; convId: string; tokensIn: number; tokensOut: number }
  | { type: 'stream-done'; convId: string; title?: string }
  | { type: 'stream-error'; convId: string; message: string }
  | { type: 'stream-stopping' }
  /* models */
  | { type: 'models-loaded'; models: string[] }
  | { type: 'model-set'; model: string }
  /* direct-connection prefs */
  | { type: 'direct-set'; direct: DirectPrefs }

const MODEL_KEY = 'robojex-model'

function readModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) || 'deepseek-v4-flash'
  } catch {
    return 'deepseek-v4-flash'
  }
}

export const initialState: WebState = {
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
  jobs: [],
  gear: 'balanced',
  gears: [],
  gearAppliedTickMs: 60_000,
  conversations: [],
  activeConvId: null,
  messages: [],
  unread: {},
  notices: {},
  stream: { status: 'idle', convId: null, startedAt: 0 },
  model: readModel(),
  models: [],
  convsLoading: true,
  direct: api.readDirectPrefs(),
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

/** Renderer-local conversation shell for direct mode: renders like a normal
 * conversation in the sidebar, but nothing backs it server-side. */
function localConversation(id: string, model: string): Conversation {
  const now = Date.now()
  return {
    id,
    title: translate('conv.directTitle'),
    createdAt: now,
    updatedAt: now,
    pinned: 0,
    gear: '',
    model,
    archived: 0,
    messageCount: 0,
    preview: '',
  }
}

/** Live-view messages → direct-mode request history (user/assistant content
 * only; notices and error stubs dropped). */
function toDirectHistory(messages: Message[]): DirectMessage[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content !== '' && !m.error)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

/* ───────────────────── jex briefing routing (pure) ───────────────────── */

export type NoticeRoute =
  /** land the briefing in this existing conversation. */
  | { convId: string; create: false }
  /** nothing to land in — caller creates the「管家报告」conversation first. */
  | { convId: null; create: true }

/**
 * Where an inbound jex briefing (chat_out from:'jex') lands. Decision table,
 * first match wins (ids pointing at conversations no longer in the list —
 * deleted, or refs from a previous session — are treated as absent):
 *
 *  1. lastAgentConvId  — the conversation the most recent /jex was sent
 *     from; replies keep flowing back there (existing routing).
 *  2. activeConvId     — no /jex context: append into whatever conversation
 *     is currently open.
 *  3. butlerConvId     — no open conversation either: reuse the dedicated
 *     butler-report conversation created by an earlier briefing.
 *  4. create           — the user never opened a chat: spawn a fresh
 *     「管家报告」conversation so no briefing is ever lost.
 *
 * Pure on the (conversations, activeConvId) slice — reducer-independent and
 * unit-tested (test/butlerNotice.test.ts).
 */
export function routeNotice(
  state: Pick<WebState, 'conversations' | 'activeConvId'>,
  lastAgentConvId: string | null,
  butlerConvId: string | null,
): NoticeRoute {
  const alive = (id: string | null): id is string =>
    id !== null && state.conversations.some((c) => c.id === id)
  if (alive(lastAgentConvId)) return { convId: lastAgentConvId, create: false }
  if (alive(state.activeConvId)) return { convId: state.activeConvId, create: false }
  if (alive(butlerConvId)) return { convId: butlerConvId, create: false }
  return { convId: null, create: true }
}

/** Bump a conversation to the top of its sort group (preview + updatedAt). */
export function reducer(state: WebState, action: Action): WebState {
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
    // initial-connection catalog fetch: the REST response may land AFTER a
    // newer WS gear frame (server applies gear asynchronously), so it must
    // never regress state.gear — hello + gear frames own the gear value
    case 'gears-catalog':
      return { ...state, gears: action.gears, gearAppliedTickMs: action.appliedTickMs }
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
      // drop the deleted conversation's bookkeeping too (badge + parked cards)
      const unread = { ...state.unread }
      delete unread[action.id]
      const notices = { ...state.notices }
      delete notices[action.id]
      return {
        ...state,
        conversations,
        activeConvId: activeGone ? null : state.activeConvId,
        messages: activeGone ? [] : state.messages,
        unread,
        notices,
      }
    }
    case 'conv-selected': {
      if (action.id === null) return { ...state, activeConvId: null, messages: [] }
      // opening the conversation clears its badge (spec: 点开清零) — the
      // parked cards stay buffered until the messages actually load
      const unread = { ...state.unread }
      delete unread[action.id]
      if (!action.loaded) return { ...state, activeConvId: action.id, messages: action.messages, unread }
      // final load: splice briefings that arrived while the conversation was
      // closed onto the server history, then retire the buffer
      const parked = state.notices[action.id] ?? []
      const notices = { ...state.notices }
      delete notices[action.id]
      return {
        ...state,
        activeConvId: action.id,
        messages: parked.length > 0 ? [...action.messages, ...parked] : action.messages,
        unread,
        notices,
      }
    }
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
    case 'agent-msg': {
      // /jex send card — client-only by design: the server conversation
      // store never sees these, so they live just in the open live view of
      // the target conversation (which the dispatch flow guarantees is open).
      if (state.activeConvId !== action.convId) return state
      const msg: Message = {
        id: nextId(),
        convId: action.convId,
        role: 'notice',
        kind: action.kind,
        content: action.text,
        createdAt: Date.now(),
      }
      return { ...state, messages: [...state.messages, msg] }
    }
    case 'agent-notice': {
      // jex briefing routed by routeNotice(): live card when the target is
      // the open conversation, otherwise parked in the per-conv buffer and
      // counted unread (sidebar badge) for replay on the next open.
      const msg: Message = {
        id: nextId(),
        convId: action.convId,
        role: 'notice',
        kind: 'agent-notice',
        content: action.text,
        createdAt: Date.now(),
      }
      if (state.activeConvId === action.convId) {
        return { ...state, messages: [...state.messages, msg] }
      }
      return {
        ...state,
        // surface the conversation in the sidebar: recency bump (floats to
        // the top of its group) + preview of the latest briefing — local
        // only, the next conversations refresh restores server truth
        conversations: state.conversations.map((c) =>
          c.id === action.convId
            ? { ...c, updatedAt: msg.createdAt, preview: msg.content.slice(0, 80) }
            : c,
        ),
        notices: { ...state.notices, [action.convId]: [...(state.notices[action.convId] ?? []), msg] },
        unread: { ...state.unread, [action.convId]: (state.unread[action.convId] ?? 0) + 1 },
      }
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
    case 'stream-tool': {
      // SSE 'tool' frames → client-only toolSteps on the streaming assistant
      // message. 'running' pushes a new step; 'done' flips the last same-name
      // running step (orphan done → push an already-completed step, tolerant
      // of frames racing a reload/switch).
      if (state.activeConvId !== action.convId) return state
      const messages = [...state.messages]
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role !== 'assistant' || !m.streaming) continue
        const steps = [...(m.toolSteps ?? [])]
        if (action.state === 'running') {
          steps.push({ name: action.name, args: action.args, state: 'running' })
        } else {
          let j = -1
          for (let k = steps.length - 1; k >= 0; k--) {
            if (steps[k].name === action.name && steps[k].state === 'running') {
              j = k
              break
            }
          }
          if (j >= 0) {
            steps[j] = { ...steps[j], state: 'done', preview: action.preview ?? steps[j].preview }
          } else {
            steps.push({ name: action.name, args: action.args, state: 'done', preview: action.preview })
          }
        }
        messages[i] = { ...m, toolSteps: steps }
        break
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
        // stop early enough and content is still '' — POST /api/conversations
        // returns no preview, so guard both before .slice (P0.5 crash fix)
        const lastContent = lastMsg?.content || conv.preview || ''
        const finished = state.messages.some((m) => m.streaming)
        conversations = state.conversations.map((c) =>
          c.id === action.convId
            ? {
                ...c,
                updatedAt: Date.now(),
                preview: lastContent.slice(0, 80),
                title: action.title || c.title,
                messageCount: (c.messageCount ?? 0) + (finished ? 1 : 0),
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
    case 'direct-set':
      return { ...state, direct: action.direct }

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
    case 'jobs':
      return { ...state, jobs: frame.jobs }
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
  /** legacy WS chat into the jex loop (agent orchestration channel); renders
   * the send + later jex replies as timeline cards in that conversation. */
  sendAgentChat(text: string): Promise<void>
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

  /** Speak the latest reply aloud (Ctrl+Alt+R desktop action, SPEC-VOICE).
   *  Pref-independent: the hotkey is an explicit ask. */
  speakLatest(): void

  /* direct-connection prefs (SPEC §1 fallback) */
  setDirectPrefs(patch: Partial<DirectPrefs>): void
}

const StoreContext = createContext<StoreApi | null>(null)

const REPLY_TIMEOUT_MS = 30_000

/** Localized command echo / error text (snapshot lang — works outside React). */
const msg = (key: string, params: Record<string, string | number> = {}): string =>
  fill(translate(key), params)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Long briefing bodies get clipped so the OS toast stays one line-ish. */
const NOTIFY_BODY_MAX = 160

/**
 * Electron bridge: hand a jex briefing to the desktop shell as an OS
 * notification (window.robojex.notify — main process shows the toast and
 * focuses the app on click). window.robojex only exists inside the desktop
 * shell; in a plain browser this is a silent no-op.
 */
function sysNotify(title: string, body: string): void {
  try {
    const w = window as unknown as { robojex?: { notify?: (t: string, b: string) => void } }
    w.robojex?.notify?.(title, body.length > NOTIFY_BODY_MAX ? `${body.slice(0, NOTIFY_BODY_MAX)}…` : body)
  } catch {
    // pure browser / bridge hiccup — the in-app badge already covers it
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const [activityItems, setActivityItems] = useState<ActivityItem[]>([])
  const activityRef = useRef(activityItems)
  activityRef.current = activityItems

  const connRef = useRef<ConnectionHandle | null>(null)
  const streamRef = useRef<StreamHandle | null>(null)
  /* tray status mirror (desktop shell only — a silent no-op in a browser):
     gear + connection are the live jex state the tray surfaces while the
     window is hidden. Language switches re-push so the localized gear
     label never goes stale behind the static last value. */
  useEffect(() => {
    const push = (): void =>
      pushTrayStatus(trayStatusFor(stateRef.current.gear, stateRef.current.gears, stateRef.current.conn === 'live'))
    push()
    window.addEventListener(LANG_EVENT, push)
    return () => window.removeEventListener(LANG_EVENT, push)
  }, [state.gear, state.gears, state.conn])
  /** conversation the most recent /jex was dispatched from; later jex
   * chat_out frames render as 'agent-notice' cards there. Session-local. */
  const agentConvRef = useRef<string | null>(null)
  /** last tasks-snapshot status map (T8 toast diff). null until the first
   * frame arrives — the baseline snapshot must never toast the board. */
  const prevTaskStatusRef = useRef<Record<string, string> | null>(null)
  /** the dedicated「管家报告」conversation auto-created for briefings that
   * arrive with no /jex context and no open conversation — reused from then
   * on so unprompted jex chatter never spawns a conversation per briefing.
   * Session-local, like agentConvRef. */
  const butlerConvRef = useRef<string | null>(null)
  /** briefings that arrived while the butler conversation was still being
   * created — flushed into it once POST /api/conversations resolves, so a
   * burst never spawns one conversation per briefing. */
  const butlerQueueRef = useRef<string[]>([])
  const butlerCreatingRef = useRef(false)

  /* ── boot: WS + initial REST loads ── */
  const loadedOnce = useRef(false)
  useEffect(() => {
    /** Drain briefings that arrived with nowhere to land: create the
     * 「管家报告」conversation once, flush every queued text into it, and
     * keep draining while more stream in — a burst never spawns one
     * conversation per briefing. */
    const pumpButler = async (): Promise<void> => {
      butlerCreatingRef.current = true
      try {
        let conv: Conversation | null = null
        while (butlerQueueRef.current.length > 0) {
          const batch = butlerQueueRef.current
          butlerQueueRef.current = []
          if (!conv) {
            try {
              conv = await api.createConversation(translate('conv.butlerTitle'))
              butlerConvRef.current = conv.id
              dispatch({ type: 'conv-created', conv })
            } catch {
              // REST down while the WS still talks — fall back to the
              // legacy pill (needs an open conversation to render; the
              // Activity transcript carries the text either way)
              for (const q of batch) dispatch({ type: 'chat-notice', text: `jex · ${q}` })
              continue // creation retried when the next briefing arrives
            }
          }
          for (const q of batch) dispatch({ type: 'agent-notice', convId: conv.id, text: q })
        }
      } finally {
        butlerCreatingRef.current = false
        // frames that raced the flag reset: re-pump instead of stranding them
        if (butlerQueueRef.current.length > 0) void pumpButler()
      }
    }
    connRef.current = connectEvents({
      url: eventsUrl(),
      onFrame: (frame) => {
        dispatch({ type: 'frame', frame })
        setActivityItems((prev) => ingestFrame(frame as unknown as Record<string, unknown>, prev))
        // T8: task done / blocked jumps earn an OS toast (desktop shell;
        // browser no-op). diffed against the last snapshot so reconnects
        // never re-toast the whole board; same gate + hide-clip as briefings.
        const f = frame as { t: string; from?: string; text?: string; tasks?: unknown }
        if (f.t === 'tasks') {
          const events = diffTaskTransitions(prevTaskStatusRef.current, f.tasks)
          prevTaskStatusRef.current = snapshotStatuses(f.tasks)
          if (api.readNotifySys()) {
            for (const ev of events) {
              sysNotify(
                translate(ev.kind === 'done' ? 'act.done' : 'act.blocked'),
                (ev.title || translate(ev.kind === 'done' ? 'act.done' : 'act.blocked')) +
                  (ev.kind === 'done' && ev.detail ? ` — ${ev.detail}` : ''),
              )
            }
          }
        }
        // route jex briefings into a conversation so they are never lost
        if (f.t === 'chat_out' && f.from === 'jex' && f.text) {
          const text = f.text
          const st = stateRef.current
          const route = routeNotice(st, agentConvRef.current, butlerConvRef.current)
          const docHidden = typeof document !== 'undefined' && document.hidden
          // OS toast when the briefing lands outside the open conversation,
          // or the window is hidden entirely (desktop bridge; browser no-op)
          const outsideOpen = route.create || route.convId !== st.activeConvId
          if (api.readNotifySys() && (outsideOpen || docHidden)) {
            sysNotify(translate('notify.butlerTitle'), text)
          }
          // 语音汇报 (SPEC-VOICE): jex briefings are spoken aloud too —
          // the但ler literally reports in voice when the pref is on
          if (readVoiceReport()) void speak(text)
          if (route.create) {
            // no conversation to land in — queue behind the butler pump
            butlerQueueRef.current.push(text)
            if (!butlerCreatingRef.current) void pumpButler()
          } else {
            dispatch({ type: 'agent-notice', convId: route.convId, text })
          }
        }
      },
      onStatus: (conn) => {
        dispatch({ type: 'conn', conn })
        if (conn === 'live' && !loadedOnce.current) {
          loadedOnce.current = true
          void api.getGear().then(
            (g) => dispatch({ type: 'gears-catalog', gears: g.gears, appliedTickMs: g.appliedTickMs }),
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

  const setMode = useCallback(
    (mode: Mode) => {
      void fetch('/api/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      }).then(
        (res) => {
          if (res.ok) localMsg(msg('cmd.modeEcho', { mode }))
          else localMsg(msg('cmd.modeRejected', { code: res.status }))
        },
        (err: unknown) => {
          localMsg(msg('cmd.modeFailed', { err: errText(err) }))
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
          if (!res.ok) localMsg(msg('cmd.missionRejected', { code: res.status }))
        },
        (err: unknown) => {
          localMsg(msg('cmd.missionFailed', { err: errText(err) }))
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
        dispatch({ type: 'chat-notice', text: msg('cmd.gearSwitched', { name: gearDisplayName(gear) }) })
      } catch (err) {
        localMsg(msg('cmd.gearFailed', { err: errText(err) }))
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
      localMsg(msg('cmd.newConvFailed', { err: errText(err) }))
      return null
    }
  }, [localMsg])

  /* ── jex agent ops (legacy channel) ── */
  const sendAgentChat = useCallback(
    async (text: string) => {
      const body = text.trim()
      if (!body) return
      let convId = stateRef.current.activeConvId
      if (!convId) {
        // give the round-trip a home: open a conversation first
        const conv = await newConversation()
        if (!conv) return
        convId = conv.id
      }
      // route later jex chat_out frames back into this conversation
      agentConvRef.current = convId
      // optimistic timeline card; client-only — chat-service does not persist
      // /jex sends, so the card lives just in this session's live view
      dispatch({ type: 'agent-msg', convId, kind: 'agent-send', text: body })
      dispatch({ type: 'sent' })
      if (connRef.current?.sendChat(body)) return
      void fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      }).then(
        (res) => {
          if (!res.ok) localMsg(msg('cmd.sendRejected', { code: res.status }))
        },
        (err: unknown) => {
          localMsg(msg('cmd.sendFailed', { err: errText(err) }))
        },
      )
    },
    [localMsg, newConversation],
  )

  const selectConversation = useCallback(async (id: string | null) => {
    if (id === null) {
      dispatch({ type: 'conv-selected', id: null, messages: [] })
      return
    }
    // optimistic clear, then load
    dispatch({ type: 'conv-selected', id, messages: [] })
    try {
      const messages = await api.listMessages(id)
      // ignore stale loads after another switch; `loaded` splices parked
      // briefing cards into the freshly fetched history
      if (stateRef.current.activeConvId === id) {
        dispatch({ type: 'conv-selected', id, messages, loaded: true })
      }
    } catch (err) {
      localMsg(msg('cmd.loadMsgsFailed', { err: errText(err) }))
    }
  }, [localMsg])

  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      const conv = await api.updateConversation(id, { title })
      dispatch({ type: 'conv-updated', conv })
    } catch (err) {
      localMsg(msg('cmd.renameFailed', { err: errText(err) }))
    }
  }, [localMsg])

  const togglePinConversation = useCallback(async (id: string, pinned: boolean) => {
    try {
      const conv = await api.updateConversation(id, { pinned })
      dispatch({ type: 'conv-updated', conv })
    } catch (err) {
      localMsg(msg('cmd.pinFailed', { err: errText(err) }))
    }
  }, [localMsg])

  const deleteConversationById = useCallback(
    async (id: string) => {
      try {
        await api.deleteConversation(id)
        dispatch({ type: 'conv-deleted', id })
      } catch (err) {
        localMsg(msg('cmd.deleteFailed', { err: errText(err) }))
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
      localMsg(msg('cmd.deleteMsgFailed', { err: errText(err) }))
    }
  }, [localMsg])

  /* ── streaming chat ── */
  /** content deltas of the stream in flight — accumulate here because the
   *  reducer's message updates land asynchronously; 'done' needs the final
   *  text NOW to decide on voice reporting. */
  const streamTextRef = useRef('')
  const consumeStream = useCallback((convId: string, ev: ChatStreamEvent) => {
    switch (ev.type) {
      case 'meta':
        streamTextRef.current = ''
        dispatch({ type: 'stream-meta', convId, userMsgId: ev.userMsgId, assistantMsgId: ev.assistantMsgId, model: ev.model })
        break
      case 'reasoning':
        dispatch({ type: 'stream-delta', convId, field: 'reasoning', delta: ev.delta })
        break
      case 'content':
        streamTextRef.current += ev.delta
        dispatch({ type: 'stream-delta', convId, field: 'content', delta: ev.delta })
        break
      case 'tool':
        dispatch({
          type: 'stream-tool',
          convId,
          name: ev.name,
          args: ev.args,
          state: ev.state,
          preview: ev.preview,
        })
        break
      case 'usage':
        dispatch({ type: 'stream-usage', convId, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut })
        break
      case 'title':
        dispatch({ type: 'stream-done', convId, title: ev.title })
        break
      case 'done': {
        dispatch({ type: 'stream-done', convId })
        // 语音汇报 (SPEC-VOICE): speak the finished reply aloud when on
        if (readVoiceReport() && streamTextRef.current.trim()) void speak(streamTextRef.current)
        streamTextRef.current = ''
        break
      }
      case 'error':
        dispatch({ type: 'stream-error', convId, message: ev.message })
        break
    }
  }, [])

  /* ── direct mode (browser → provider; gateway bypassed, SPEC §1) ── */
  const runDirectStream = useCallback(
    async (convId: string, messages: DirectMessage[]) => {
      const prefs = stateRef.current.direct
      const model = prefs.model || stateRef.current.model
      const handle = api.chatStreamDirect(
        { conversationId: convId, messages, model, prefs },
        (ev) => consumeStream(convId, ev),
      )
      streamRef.current = handle
      await handle.done
      streamRef.current = null
    },
    [consumeStream],
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const body = text.trim()
      if (!body || stateRef.current.stream.status === 'streaming') return
      const direct = api.directEnabled(stateRef.current.direct)
      let convId = stateRef.current.activeConvId
      if (!convId) {
        if (direct) {
          // fallback home: a renderer-local conversation, no backend
          // round-trip — it lives only in this session, refresh drops it
          // (intentional tradeoff of the direct mode)
          convId = nextId()
          const model = stateRef.current.direct.model || stateRef.current.model
          dispatch({ type: 'conv-created', conv: localConversation(convId, model) })
        } else {
          const conv = await newConversation()
          if (!conv) return
          convId = conv.id
        }
      }
      const prior = stateRef.current.messages
      // optimistic user message
      dispatch({
        type: 'conv-selected',
        id: convId,
        messages: [
          ...prior,
          { id: nextId(), convId, role: 'user', content: body, createdAt: Date.now() },
        ],
      })
      dispatch({ type: 'stream-start', convId })
      if (direct) {
        // direct fallback: messages are NOT persisted server-side — the
        // conversation dies with the renderer session, by design
        await runDirectStream(convId, [...toDirectHistory(prior), { role: 'user', content: body }])
        return
      }
      const handle = api.streamChat(
        { conversationId: convId, text: body, model: stateRef.current.model },
        (ev) => consumeStream(convId, ev),
      )
      streamRef.current = handle
      await handle.done
      streamRef.current = null
    },
    [consumeStream, newConversation, runDirectStream],
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
    if (api.directEnabled(stateRef.current.direct) && msgs.length > 0) {
      // fallback mode: replay the live history straight to the provider —
      // the gateway holds no record of these turns to truncate server-side
      dispatch({ type: 'stream-start', convId })
      await runDirectStream(convId, toDirectHistory(msgs))
      return
    }
    dispatch({ type: 'stream-start', convId })
    const handle = api.regenerate(convId, (ev) => consumeStream(convId, ev))
    streamRef.current = handle
    await handle.done
    streamRef.current = null
  }, [consumeStream, runDirectStream])

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

  /* ── voice readback (Ctrl+Alt+R; SPEC-VOICE) ── */
  const speakLatest = useCallback(() => {
    const st = stateRef.current
    // the open conversation's last real assistant reply first…
    const last = [...st.messages].reverse().find((m) => m.role === 'assistant' && !m.error && m.content.trim())
    // …falling back to the latest jex line in the legacy transcript
    const jexLine = [...st.transcript].reverse().find((i) => i.kind === 'msg' && i.from === 'jex')
    const text = last?.content ?? (jexLine && jexLine.kind === 'msg' ? jexLine.text : '')
    if (text) void speak(text)
  }, [])

  /* ── direct-connection prefs ── */
  const setDirectPrefs = useCallback((patch: Partial<DirectPrefs>) => {
    const next = { ...stateRef.current.direct, ...patch }
    api.writeDirectPrefs(next)
    dispatch({ type: 'direct-set', direct: next })
  }, [])

  /* ── slash commands ── */
  const runCommand = useCallback(
    (raw: string): boolean => {
      const text = raw.trim()
      if (!text.startsWith('/')) return false
      const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text)
      if (!m) {
        localMsg(msg('cmd.unknown', { text }))
        return true
      }
      const [, name, rawArg = ''] = m
      // picking a palette entry can submit its placeholder verbatim
      // ('/model <name>'); treat that as "no argument given"
      const arg = /^<[^>]*>$/.test(rawArg.trim()) ? '' : rawArg
      switch (name) {
        case 'mode': {
          const mode = arg.trim() as Mode
          if (mode === 'observe' || mode === 'assist' || mode === 'full') setMode(mode)
          else localMsg(msg('cmd.modeUsage'))
          return true
        }
        case 'gear': {
          const gear = arg.trim() as GearId
          if (gear === 'dormant' || gear === 'eco' || gear === 'balanced' || gear === 'focused' || gear === 'turbo') {
            void changeGear(gear)
          } else {
            const cur = stateRef.current.gear
            localMsg(msg('cmd.gearUsage', { gear: gearDisplayName(cur) }))
          }
          return true
        }
        case 'model': {
          const model = arg.trim()
          if (model) setModel(model)
          else localMsg(msg('cmd.modelCurrent', { model: stateRef.current.model }))
          return true
        }
        case 'models':
          void refreshModels().then(() => {
            localMsg(stateRef.current.models.join('\n') || translate('cmd.noModels'))
          })
          return true
        case 'theme': {
          const pref = arg.trim() as 'light' | 'dark' | 'system'
          if (pref === 'light' || pref === 'dark' || pref === 'system') {
            setThemePref(pref)
            localMsg(msg('cmd.themeEcho', { resolved: themeSnapshot().resolved }))
          } else localMsg(msg('cmd.themeUsage'))
          return true
        }
        case 'lang': {
          // tolerate the slash-palette placeholder '<zh|en|system>' completion
          const pref = arg.trim().replace(/^<|>$/g, '').toLowerCase()
          if (pref === 'zh' || pref === 'en' || pref === 'system') {
            setLangPref(pref)
            // echo AFTER the switch — the snapshot already carries the new lang
            localMsg(msg('cmd.langEcho', { lang: translate(`lang.${langSnapshot().lang}`) }))
          } else localMsg(msg('cmd.langUsage'))
          return true
        }
        case 'jex': {
          const body = arg.trim()
          if (body) void sendAgentChat(body)
          else localMsg(msg('cmd.jexUsage'))
          return true
        }
        case 'tasks': {
          const tasks = stateRef.current.tasks
          localMsg(
            tasks.length === 0
              ? translate('cmd.tasksEmpty')
              : tasks.map((t) => `- [${t.status}] ${t.title} (${t.id})`).join('\n'),
          )
          return true
        }
        case 'mission': {
          const body = arg.trim()
          if (!body) localMsg(msg('cmd.missionUsage'))
          else appendMission(body)
          return true
        }
        case 'budget': {
          const b = stateRef.current.budget
          localMsg(
            b
              ? msg('cmd.budgetLine', { line: b.line, spent: b.spentToday, daily: b.dailyTokens })
              : translate('cmd.budgetUnknown'),
          )
          return true
        }
        case 'help':
          localMsg(translate('cmd.help'))
          return true
        default:
          localMsg(msg('cmd.unknownTry', { name }))
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
      speakLatest,
      setDirectPrefs,
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
      speakLatest,
      setDirectPrefs,
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
