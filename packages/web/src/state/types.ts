// packages/web/src/state/types.ts — frozen wire contract from dsh-plan.md.
// Mirrors the core API on :7620 (GET /api/state, WS /api/events).

export type Mode = 'observe' | 'assist' | 'full'

export interface Task {
  id: string
  title: string
  status: string
  resultSummary?: string
  createdAt: number
}

export interface Budget {
  mode: Mode
  dailyTokens: number
  spentToday: number
  line: string
}

export interface ChatMsg {
  from: 'user' | 'jex' | 'system'
  ts: number
  text: string
}

export interface StateSnapshot {
  tasks: Task[]
  budget: Budget
  mode: Mode
  mission: string
  rubric: string
  memory: string
  chat: ChatMsg[]
  version: string
}

/** One decided action inside a cycle frame; shape is open-ended. */
export interface CycleAction {
  type: string
  text?: string
  title?: string
  [key: string]: unknown
}

export type ServerFrame =
  | { t: 'hello'; state: StateSnapshot }
  | { t: 'chat_out'; from: 'user' | 'jex' | 'system'; text: string; ts: number }
  | { t: 'tasks'; tasks: Task[] }
  | { t: 'cycle'; wake: string; cost: number; actions: CycleAction[] }
  | { t: 'mode'; mode: Mode }
  | { t: 'budget'; line: string }

/** Unified chat transcript entry rendered by ChatStream. */
export type TranscriptItem =
  | { kind: 'msg'; id: number; from: 'user' | 'jex' | 'system'; text: string; ts: number }
  | {
      kind: 'cycle'
      id: number
      wake: string
      cost: number
      actions: CycleAction[]
      ts: number
    }
  | { kind: 'toast'; id: number; tone: 'info' | 'success' | 'warn' | 'error'; text: string; ts: number }
