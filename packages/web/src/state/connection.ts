// packages/web/src/state/connection.ts — generation-based WS reconnect loop.
// Adapted from the DSH ConnectionController pattern (packages/client/connection):
// each socket is a generation; loss bumps the attempt counter and schedules a
// reconnect with exponential backoff 1s -> 16s; a fresh `hello` frame lets the
// store rebuild full state afterwards.

import type { ServerFrame } from './types'

export type ConnStatus = 'connecting' | 'live' | 'reconnecting'

export interface ConnectionOptions {
  url: string
  onFrame: (frame: ServerFrame) => void
  onStatus: (status: ConnStatus) => void
}

export interface ConnectionHandle {
  close(): void
  /** Send a chat frame over the live socket; false when not open. */
  sendChat(text: string): boolean
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 16_000

export function eventsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/events`
}

export function connectEvents(opts: ConnectionOptions): ConnectionHandle {
  let stopped = false
  let ws: WebSocket | null = null
  let attempt = 0
  let timer: number | undefined

  const backoffMs = (): number => {
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  const open = (): void => {
    if (stopped) return
    opts.onStatus(attempt === 0 ? 'connecting' : 'reconnecting')
    try {
      ws = new WebSocket(opts.url)
    } catch {
      scheduleRetry()
      return
    }
    ws.onopen = () => {
      if (stopped) return
      attempt = 0
      opts.onStatus('live')
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (stopped) return
      let frame: ServerFrame
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerFrame
      } catch {
        return // ignore malformed carriers
      }
      if (frame && typeof frame.t === 'string') opts.onFrame(frame)
    }
    ws.onclose = () => {
      ws = null
      scheduleRetry()
    }
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    }
  }

  const scheduleRetry = (): void => {
    if (stopped) return
    attempt += 1
    opts.onStatus('reconnecting')
    timer = window.setTimeout(open, backoffMs())
  }

  open()

  return {
    close() {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      if (ws) {
        ws.onclose = null // deliberate teardown is not a retry trigger
        ws.close()
        ws = null
      }
    },
    sendChat(text: string): boolean {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify({ t: 'chat', text }))
      return true
    },
  }
}
