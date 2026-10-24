// packages/web/src/state/types.ts — wire contract for the desktop app.
// Mirrors the core API on :7620 (REST + WS /api/events + SSE /api/chat/stream).
// This file is the frozen contract between ceo-core and the web UI;
// change both sides together (see docs/SPEC-DESKTOP.md).

export type Mode = 'observe' | 'assist' | 'full'

/* ─────────────────────────── gears (自主挡位) ─────────────────────────── */

export type GearId = 'dormant' | 'eco' | 'balanced' | 'focused' | 'turbo'

/** Gear definition as shipped by GET /api/gear (list) and mirrored in ceo-core gears.ts. */
export interface GearDef {
  id: GearId
  level: number // 0..4
  name: string // 中文显示名
  emoji: string
  /** 0 = loop stopped (dormant). */
  tickMs: number
  decideMaxTokens: number
  /** patrol runs every N ticks (0 = never). */
  patrolEvery: number
  desc: string
  /** one-line cost hint shown in the switcher */
  cost: string
}

export const GEAR_LEVELS: GearId[] = ['dormant', 'eco', 'balanced', 'focused', 'turbo']

/* ─────────────────────────── tasks / budget (board v2) ─────────────────── */

export interface Task {
  id: string
  title: string
  status: string
  /** board ordering ladder — higher renders first among siblings; drag-drop
   * reorder (POST /api/task/reorder) rewrites it server-side */
  priority?: number
  resultSummary?: string
  createdAt: number
  parentId?: string | null
  scheduledAt?: number | null
  dueAt?: number | null
  progress?: number
  verdict?: string
  acceptance?: string
  /** agent framework the card was dispatched to ('' = never dispatched; only those are operator-done-able) */
  assignee?: string
  /** T4 gantt milestone flag — drawn as a ◆ on the timeline, operator-toggled */
  milestone?: boolean
}

export interface Budget {
  mode: 'burn' | 'budgeted'
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
  now?: number
  tickN?: number
  gear?: GearId
  /** autonomy policy (SPEC-BUTLER §1): the core has sent this since T3 —
   *  optional so older cores / readers tolerate its absence. */
  policy?: 'butler' | 'conservative'
  /** T7 late-joiner replay: recent thinking-trace steps (oldest first).
   *  Optional: cores predating the thinking stream omit the field. */
  thinking?: ThinkStep[]
}

/** T7 thinking stream: one backend-authoritative reasoning step.
 *  Every step carries an id (shared by the live `think` frame, the cycle
 *  frame's trace and the hello replay — the client deduplicates on it),
 *  a wall-clock ts, the owning wake, and whatever token bill that phase
 *  paid. Kinds: wake | patrol | decide | spawn | spawn_done | audit |
 *  audit_review | error. Unknown kinds must render as a plain line —
 *  a newer core may ship more. */
export interface ThinkStep {
  id: number
  ts: number
  wake?: number
  tickN?: number
  kind: string
  tokens?: number
  promptTokens?: number
  completionTokens?: number
  title?: string
  framework?: string
  taskId?: string
  ok?: boolean
  verdict?: string
  detail?: string
  actions?: { type: string; title: string }[]
}

export interface CycleAction {
  type: string
  text?: string
  title?: string
  [key: string]: unknown
}

export interface HudNotice {
  kind: 'due_spawn' | 'overdue' | 'unlocked' | 'verify_due'
  taskId: string
  ts: number
}

/* ─────────────────────────── conversations ─────────────────────────── */

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: 0 | 1
  gear: string
  model: string
  archived: 0 | 1
  messageCount: number
  /** server-computed preview of the latest message (≤80 chars). */
  preview: string
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'notice'

/** One in-stream tool execution (SSE 'tool' frames): a 'running' step arrives
 * first (name + args), later completed by a same-name 'done' carrying a short
 * preview of the real output. Never persisted — see Message.toolSteps. */
export interface ToolStep {
  name: string
  args?: string
  state: 'running' | 'done'
  preview?: string
}

export interface Message {
  id: string
  convId: string
  role: MessageRole
  content: string
  reasoning?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  createdAt: number
  error?: string
  /** client-only: in-stream tool executions rendered as cards between the
   * thinking fold and the reply body. History loads from the server carry no
   * toolSteps, so these vanish on refresh by design. */
  toolSteps?: ToolStep[]
  /** client-only: message is currently streaming (deltas append). */
  streaming?: boolean
  /** client-only: elapsed stream seconds, for the “已思考 Xs” badge. */
  thinkSecs?: number
  /** client-only render flavor: chat (default) or an agent-channel timeline
   * card — /jex dispatches ('agent-send') and jex replies ('agent-notice').
   * Never persisted server-side; chat-service does not store these. */
  kind?: 'chat' | 'agent-send' | 'agent-notice'
}

/** SSE frames on POST /api/chat/stream (each `data: {json}`). */
export type ChatStreamEvent =
  | { type: 'meta'; conversationId: string; userMsgId: string; assistantMsgId: string; model: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  /** tool grounding: jex runs a local tool (e.g. nvidia-smi) mid-stream —
   * 'running' first (name + args), then a same-name 'done' with preview.
   * Arrives after meta, before the final content; ≤3 tools per stream. */
  | { type: 'tool'; name: string; args?: string; state: 'running' | 'done'; preview?: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number }
  | { type: 'title'; title: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type StreamStatus = 'idle' | 'streaming' | 'stopping' | 'error'

export interface StreamState {
  status: StreamStatus
  convId: string | null
  startedAt: number
  error?: string
}

export interface DayUsage {
  day: string // YYYY-MM-DD
  tokensIn: number
  tokensOut: number
  calls: number
}

/* ─────────────────────────── settings ─────────────────────────── */

export interface Settings {
  baseUrl: string
  apiKey: string // masked by server (abcd***wxyz)
  patrolModel: string
  decideModel: string
  budgetMode: 'burn' | 'budgeted'
  dailyTokens: number
  tickMs: number
  takeoverUrl: string
  apiPort: number
  apiHost: string
  /** autonomy policy (SPEC-BUTLER §1). Optional: cores predating the butler
   * spec omit the field — readers must tolerate undefined. */
  policy?: 'butler' | 'conservative'
  /** thinking mode: OFF by default (absent = false). Toggled in settings;
   *  the backend hot-applies it to every LLM request. */
  thinking?: boolean
}

/* ─────────────────────────── WS frames ─────────────────────────── */

export type ServerFrame =
  | { t: 'hello'; state: StateSnapshot }
  | { t: 'chat_out'; from: 'user' | 'jex' | 'system'; text: string; ts: number }
  | { t: 'tasks'; tasks: Task[] }
  | { t: 'cycle'; wake: number; tickN?: number; cost: number; actions: CycleAction[]; trace?: ThinkStep[] }
  | { t: 'think'; step: ThinkStep }
  | ({ t: 'hud' } & HudNotice)
  | { t: 'mode'; mode: Mode }
  | { t: 'budget'; line: string; budget?: Budget }
  | { t: 'gear'; gear: GearId }
  | { t: 'jobs'; jobs: JobInfo[] }
  /** autonomy policy hot-switch (loop.setPolicy, SPEC-BUTLER §1). Emitted by
   *  the core since T3 — consumed here so the vocabulary stays aligned (an
   *  unlisted frame used to blank the whole app; see t_34df9d82). */
  | { t: 'policy'; policy: 'butler' | 'conservative' }

/** One background shell job (job_start …): the CommandCenter strip shows what
 *  the butler is running behind the board. state mirrors the core registry;
 *  finished jobs ride along until the core's retention sweep drops them. */
export interface JobInfo {
  id: string
  command: string
  state: 'running' | 'done' | 'killed'
  exitCode: number | null
  timedOut: boolean
  startedAt: number
  endedAt: number | null
}

/** Unified agent-transcript entry (legacy ring + synthesized), for the
 * Activity view and inline jex notices inside chat conversations. */
export type TranscriptItem =
  | { kind: 'msg'; id: number; from: 'user' | 'jex' | 'system'; text: string; ts: number }
  | {
      kind: 'cycle'
      id: number
      wake: number
      cost: number
      actions: CycleAction[]
      ts: number
      /** T7: the cycle's phase trace (absent on older cores). Its presence
       *  suppresses the legacy frame-derived ThinkingStream summary. */
      trace?: ThinkStep[]
    }
  | { kind: 'toast'; id: number; tone: 'info' | 'success' | 'warn' | 'error'; text: string; ts: number }

/** Re-exported from activityModel for convenience. */
export type { ActivityItem } from '../views/activityModel'
