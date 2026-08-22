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
