// packages/web/src/state/types.ts — frozen wire contract from dsh-plan.md.
// Mirrors the core API on :7620 (GET /api/state, WS /api/events).

export type Mode = 'observe' | 'assist' | 'full'

export interface Task {
  id: string
  title: string
  status: string
  resultSummary?: string
  createdAt: number
  /** board v2: parent task id (null = root); absent on pre-v2 cores. */
  parentId?: string | null
  /** board v2: planned start, epoch ms. */
  scheduledAt?: number | null
  /** board v2: deadline, epoch ms. */
  dueAt?: number | null
  /** HUD: 0..100 completion estimate (shipped by core since taskView). */
  progress?: number
  /** HUD: verify verdict against the acceptance standard. */
  verdict?: string
  /** HUD: acceptance standard the verify loop checks. */
  acceptance?: string
}

export interface Budget {
  mode: 'burn' | 'budgeted' // core BudgetGovernor mode, not the takeover mode
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
  /** board v2: server epoch ms — clock alignment for sched/due rendering. */
  now?: number
  /** HUD: decision-cycle count; compare with cycle frames' tickN to detect a stalled core. */
  tickN?: number
}

/** One decided action inside a cycle frame; shape is open-ended. */
export interface CycleAction {
  type: string
  text?: string
  title?: string
  [key: string]: unknown
}

/** One gantt event that just hit a task; HUD widgets flash the card. */
export interface HudNotice {
  kind: 'due_spawn' | 'overdue' | 'unlocked' | 'verify_due'
  taskId: string
  ts: number
}

export type ServerFrame =
  | { t: 'hello'; state: StateSnapshot }
  | { t: 'chat_out'; from: 'user' | 'jex' | 'system'; text: string; ts: number }
  | { t: 'tasks'; tasks: Task[] }
  | { t: 'cycle'; wake: number; tickN?: number; cost: number; actions: CycleAction[] }
  | ({ t: 'hud' } & HudNotice)
  | { t: 'mode'; mode: Mode }
  | { t: 'budget'; line: string; budget?: Budget }

/** Unified chat transcript entry rendered by ChatStream. */
export type TranscriptItem =
  | { kind: 'msg'; id: number; from: 'user' | 'jex' | 'system'; text: string; ts: number }
  | {
      kind: 'cycle'
      id: number
      wake: number
      cost: number
      actions: CycleAction[]
      ts: number
    }
  | { kind: 'toast'; id: number; tone: 'info' | 'success' | 'warn' | 'error'; text: string; ts: number }

/** Re-exported from activityModel for convenience. */
export type { ActivityItem } from '../views/activityModel'
