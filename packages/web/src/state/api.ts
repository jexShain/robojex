// packages/web/src/state/api.ts — typed REST + SSE client for the core API
// (:7620 via same-origin / vite proxy). No auth: the origin gate on the
// server side is the boundary. All functions throw on transport failure;
// callers surface errors through the store.

import type {
  ChatStreamEvent,
  Conversation,
  DayUsage,
  GearDef,
  GearId,
  Message,
  Settings,
} from './types'

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

function post(url: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' = 'POST'): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/* ───────────────────── conversations ───────────────────── */

export async function listConversations(): Promise<Conversation[]> {
  return (await json<{ conversations: Conversation[] }>(await fetch('/api/conversations'))).conversations
}

export async function createConversation(title?: string): Promise<Conversation> {
  return json<Conversation>(await post('/api/conversations', { title }))
}

export async function updateConversation(
  id: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean },
): Promise<Conversation> {
  return json<Conversation>(await post(`/api/conversations/${encodeURIComponent(id)}`, patch, 'PATCH'))
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function listMessages(convId: string): Promise<Message[]> {
  return (await json<{ messages: Message[] }>(await fetch(`/api/conversations/${encodeURIComponent(convId)}/messages`))).messages
}

export async function deleteMessage(msgId: string): Promise<void> {
  const res = await fetch(`/api/messages/${encodeURIComponent(msgId)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/* ───────────────────── streaming chat ───────────────────── */

export interface StreamRequest {
  conversationId: string
  text: string
  model?: string
  /** chat = direct LLM reply (default). */
  mode?: 'chat'
}

export interface StreamHandle {
  /** resolves with the terminal event (done | error); never rejects. */
  done: Promise<ChatStreamEvent>
  abort(): void
}

/**
 * POST /api/chat/stream and consume the SSE body.
 * Each server event is one `data: {json}` block separated by a blank line.
 */
export function streamChat(
  req: StreamRequest,
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
): StreamHandle {
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  const done = (async (): Promise<ChatStreamEvent> => {
    let terminal: ChatStreamEvent = { type: 'done' }
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(req),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        terminal = { type: 'error', message: errBody.error || `HTTP ${res.status}` }
        onEvent(terminal)
        return terminal
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buf += decoder.decode(value, { stream: true })
        let sep: number
        // SSE events are separated by a blank line (\n\n).
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const ev = JSON.parse(payload) as ChatStreamEvent
              if (ev.type === 'done' || ev.type === 'error') terminal = ev
              onEvent(ev)
            } catch {
              // partial/invalid JSON mid-stream — skip
            }
          }
        }
      }
      if (terminal.type !== 'done' && terminal.type !== 'error') terminal = { type: 'done' }
      if (terminal.type === 'done') onEvent(terminal)
    } catch (err) {
      if (controller.signal.aborted) {
        terminal = { type: 'done' }
        onEvent(terminal)
      } else {
        terminal = { type: 'error', message: err instanceof Error ? err.message : String(err) }
        onEvent(terminal)
      }
    } finally {
      signal?.removeEventListener('abort', onOuterAbort)
    }
    return terminal
  })()

  return { done, abort: () => controller.abort() }
}

/* ───────────────────── regenerate ───────────────────── */

/** Regenerate: server truncates everything after the last user message and
 * streams a fresh reply. Consumed exactly like streamChat. */
export function regenerate(
  convId: string,
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
): StreamHandle {
  return streamChat({ conversationId: convId, text: '' }, onEvent, signal)
}

/* ───────────── direct mode (browser → DeepSeek, SPEC §1 fallback) ───────────── */

export type DirectMode = 'gateway' | 'direct'

/** localStorage-backed prefs for the connection-mode picker in settings. */
export interface DirectPrefs {
  mode: DirectMode
  baseUrl: string
  apiKey: string
  /** '' = follow the store's current chat model. */
  model: string
}

/** One OpenAI-compatible turn sent straight to the provider. */
export interface DirectMessage {
  role: 'user' | 'assistant'
  content: string
}

export const DIRECT_KEY = 'robojex-direct'
export const DEFAULT_DIRECT_BASE = 'https://api.deepseek.com/v1'

export const DEFAULT_DIRECT_PREFS: DirectPrefs = {
  mode: 'gateway',
  baseUrl: DEFAULT_DIRECT_BASE,
  apiKey: '',
  model: '',
}

/** Parse the robojex-direct localStorage payload; each malformed field falls
 * back individually so a half-written value never bricks the picker. Pure. */
export function parseDirectPrefs(raw: string | null): DirectPrefs {
  if (!raw) return { ...DEFAULT_DIRECT_PREFS }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_DIRECT_PREFS }
  }
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof DirectPrefs, unknown>>
  return {
    mode: o.mode === 'direct' ? 'direct' : 'gateway',
    baseUrl: typeof o.baseUrl === 'string' && o.baseUrl.trim() ? o.baseUrl.trim() : DEFAULT_DIRECT_BASE,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    model: typeof o.model === 'string' ? o.model.trim() : '',
  }
}

export function readDirectPrefs(): DirectPrefs {
  try {
    return parseDirectPrefs(localStorage.getItem(DIRECT_KEY))
  } catch {
    return { ...DEFAULT_DIRECT_PREFS }
  }
}

/** Best-effort persist; prefs stay session-only if storage is unavailable. */
export function writeDirectPrefs(prefs: DirectPrefs): DirectPrefs {
  try {
    localStorage.setItem(DIRECT_KEY, JSON.stringify(prefs))
  } catch {
    // best-effort
  }
  return prefs
}

/** Direct mode only engages with a stored key — without one we silently stay
 * on the gateway path (the default) instead of failing every send. Pure. */
export function directEnabled(prefs: DirectPrefs): boolean {
  return prefs.mode === 'direct' && prefs.apiKey.trim() !== ''
}

/* ───────── renderer pref: butler OS notifications ───────── */

/** localStorage key for the "butler system notifications" switch in
 * Settings ▸ Chat. Read live by the store on every jex briefing frame so
 * toggling applies without any store plumbing. */
export const NOTIFY_SYS_KEY = 'robojex-notify-sys'

/** Butler OS notifications default ON ('0' = off). Pure. */
export function parseNotifySys(raw: string | null): boolean {
  return raw !== '0'
}

export function readNotifySys(): boolean {
  try {
    return parseNotifySys(localStorage.getItem(NOTIFY_SYS_KEY))
  } catch {
    return true
  }
}

/** Events parseDirectSSEChunk can emit — the ChatStreamEvent vocabulary the
 * store already consumes for gateway streams. */
export type DirectSSEEvent = Extract<ChatStreamEvent, { type: 'reasoning' | 'content' | 'usage' | 'done' }>

interface DeepSeekChunk {
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/** Split an SSE buffer into complete `data:` payloads + the incomplete tail.
 * Pure (unit-tested); chatStreamDirect drives it with TextDecoder output.
 * [DONE] maps to a done event; delta.reasoning_content / delta.content /
 * usage map onto the same events the gateway stream emits. */
export function parseDirectSSEChunk(buf: string): { events: DirectSSEEvent[]; rest: string } {
  const events: DirectSSEEvent[] = []
  const src = buf.replace(/\r\n/g, '\n') // CRLF servers split on \n\n too
  let start = 0
  for (;;) {
    const sep = src.indexOf('\n\n', start)
    if (sep < 0) break
    const block = src.slice(start, sep)
    start = sep + 2
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue // comments / event: lines
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        events.push({ type: 'done' })
        continue
      }
      let chunk: DeepSeekChunk
      try {
        chunk = JSON.parse(payload) as DeepSeekChunk
      } catch {
        continue // keep-alive / partial JSON
      }
      const delta = chunk.choices?.[0]?.delta
      if (delta) {
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          events.push({ type: 'reasoning', delta: delta.reasoning_content })
        }
        if (typeof delta.content === 'string' && delta.content) {
          events.push({ type: 'content', delta: delta.content })
        }
      }
      if (chunk.usage && typeof chunk.usage.prompt_tokens === 'number') {
        events.push({ type: 'usage', tokensIn: chunk.usage.prompt_tokens, tokensOut: chunk.usage.completion_tokens ?? 0 })
      }
    }
  }
  return { events, rest: src.slice(start) }
}

let directSeq = 0

/**
 * Browser-direct streaming against an OpenAI-compatible /chat/completions
 * endpoint (DeepSeek allows CORS; the key never touches the local gateway).
 * Fallback for when the local backend is unreachable: emits exactly the
 * streamChat event vocabulary, starting with a synthetic meta carrying
 * client-generated ids. HTTP (401/429/…) and network/CORS failures surface
 * as { type: 'error' }; abort resolves with done, like streamChat.
 */
export function chatStreamDirect(
  req: { conversationId: string; messages: DirectMessage[]; model: string; prefs: DirectPrefs },
  onEvent: (ev: ChatStreamEvent) => void,
  signal?: AbortSignal,
): StreamHandle {
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })

  const done = (async (): Promise<ChatStreamEvent> => {
    let terminal: ChatStreamEvent = { type: 'done' }
    try {
      const stamp = `direct-${Date.now().toString(36)}`
      onEvent({
        type: 'meta',
        conversationId: req.conversationId,
        userMsgId: `${stamp}-${++directSeq}u`,
        assistantMsgId: `${stamp}-${++directSeq}a`,
        model: req.model,
      })
      const base = req.prefs.baseUrl.trim().replace(/\/+$/, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${req.prefs.apiKey.trim()}`,
        },
        // stream_options.include_usage is the shape DeepSeek honors (same as
        // ceo-core llm.ts); the final chunk then carries usage
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string }
        const msg = typeof errBody.error === 'string' ? errBody.error : errBody.error?.message
        terminal = { type: 'error', message: msg || `HTTP ${res.status}` }
        onEvent(terminal)
        return terminal
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let emittedDone = false
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buf += decoder.decode(value, { stream: true })
        const { events, rest } = parseDirectSSEChunk(buf)
        buf = rest
        for (const ev of events) {
          if (ev.type === 'done') emittedDone = true
          onEvent(ev)
        }
      }
      // body closed without [DONE] (cut mid-stream) — still resolve as done
      if (!emittedDone) onEvent(terminal)
    } catch (err) {
      if (controller.signal.aborted) {
        terminal = { type: 'done' }
        onEvent(terminal)
      } else {
        terminal = { type: 'error', message: err instanceof Error ? err.message : String(err) }
        onEvent(terminal)
      }
    } finally {
      signal?.removeEventListener('abort', onOuterAbort)
    }
    return terminal
  })()

  return { done, abort: () => controller.abort() }
}

/* ───────────────────── gears ───────────────────── */

export interface GearStateDto {
  gear: GearId
  gears: GearDef[]
  appliedTickMs: number
}

export async function getGear(): Promise<GearStateDto> {
  return json<GearStateDto>(await fetch('/api/gear'))
}

export async function setGear(gear: GearId): Promise<GearStateDto> {
  return json<GearStateDto>(await post('/api/gear', { gear }, 'PUT'))
}

/* ───────────────────── models / usage / settings ───────────────────── */

export async function listModels(): Promise<string[]> {
  return (await json<{ models: string[] }>(await fetch('/api/models'))).models
}

export async function getUsage(days = 7): Promise<DayUsage[]> {
  return (await json<{ usage: DayUsage[] }>(await fetch(`/api/usage?days=${days}`))).usage
}

export async function getSettings(): Promise<Settings> {
  return json<Settings>(await fetch('/api/settings'))
}

export async function putSettings(patch: Partial<Settings>): Promise<{ ok: boolean; note?: string }> {
  return json<{ ok: boolean; note?: string }>(await post('/api/settings', patch, 'PUT'))
}
