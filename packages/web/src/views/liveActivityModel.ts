// packages/web/src/views/liveActivityModel.ts — pure derivations behind the
// LiveActivity view (T2): in-flight task cards, recent completions, the
// thinking/decision log filter and the system-heartbeat read-out. Kept free
// of React/store imports (same rule as thinkingModel.ts) so test/ can run it
// in plain node; the store's statusTone vocabulary is mirrored locally with a
// comment because store.tsx pulls React and is not test-importable here.

import type { Task } from '../state/types'
import type { ActivityItem } from './activityModel'

/* ── 1. in-flight cards ────────────────────────────────────────────── */

export interface RunningCardData {
  id: string
  title: string
  /** 0–100 when the core reports progress; null → shimmer bar. */
  progress: number | null
  /** epoch ms the task was created (start proxy). */
  startedAt: number
  /** framework the card rides (rendered as the fw badge). */
  assignee?: string
}

/** Mirrors store.tsx statusTone's 'running' branch — keep the two in sync
 *  (core statuses are exactly todo/running/done/blocked, board v2). */
export function isRunningStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('run') || s.includes('progress') || s.includes('active')
}

function clampProgress(p: unknown): number | null {
  if (typeof p !== 'number' || !Number.isFinite(p)) return null
  if (p < 0) return 0
  if (p > 100) return 100
  return Math.round(p)
}

/** Running tasks newest-first (Vercel deploy-list order). */
export function runningCards(tasks: Task[]): RunningCardData[] {
  return tasks
    .filter((t) => isRunningStatus(t.status))
    .map((t) => ({
      id: t.id,
      title: t.title,
      progress: clampProgress(t.progress),
      startedAt: t.createdAt,
      assignee: t.assignee || undefined,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/* ── 2. recent completions ─────────────────────────────────────────── */

export interface CompletionRow {
  key: string
  ts: number
  title: string
  summary?: string
  tone: 'done' | 'blocked'
}

/** task_done / task_blocked feed entries, newest-first, one row per task
 *  title (a task re-run several times only shows its latest result). */
export function recentCompletions(items: ActivityItem[], limit = 8): CompletionRow[] {
  const byTitle = new Map<string, CompletionRow>()
  for (const it of items) {
    if (it.type !== 'task_done' && it.type !== 'task_blocked') continue
    const title = it.title || ''
    const row: CompletionRow = {
      key: it.id,
      ts: it.ts,
      title,
      summary: it.detail,
      tone: it.type === 'task_done' ? 'done' : 'blocked',
    }
    if (title) {
      const prev = byTitle.get(title)
      if (prev && prev.ts >= it.ts) continue
    }
    byTitle.set(title || row.key, row)
  }
  return [...byTitle.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
}

/* ── 3. thinking / decision stream ─────────────────────────────────── */

/** Feed types that read as thinking/decisions (the Vercel build-log lane):
 *  cycle wakes, think steps, spawns, decisions that flipped mode, and the
 *  outcomes that closed them. Chat replies and budget/tick noise stay in
 *  the plain Activity feed. */
export const STREAM_TYPES: ReadonlySet<ActivityItem['type']> = new Set([
  'cycle',
  'think',
  'spawn',
  'mode',
  'task_done',
  'task_blocked',
])

export function decisionStream(items: ActivityItem[], limit = 60): ActivityItem[] {
  return items.filter((it) => STREAM_TYPES.has(it.type)).slice(0, limit)
}

/* ── 4. system heartbeat ───────────────────────────────────────────── */

export type HeartLevel = 'ok' | 'lag' | 'down'

export interface Heartbeat {
  level: HeartLevel
  /** seconds since the last beat; null when no beat has been seen yet. */
  secondsSince: number | null
}

/** The newest tick/cycle item is the last beat the agent actually spoke. */
export function lastBeatTs(items: ActivityItem[]): number | null {
  for (const it of items) {
    if (it.type === 'tick' || it.type === 'cycle') return it.ts
  }
  return null
}

/** WS down ⇒ down; a beat older than staleSec while nominally live ⇒ lag. */
export function heartbeat(
  conn: 'connecting' | 'live' | 'reconnecting',
  lastBeat: number | null,
  now: number,
  staleSec = 90,
): Heartbeat {
  if (conn !== 'live') return { level: 'down', secondsSince: null }
  if (lastBeat === null) return { level: 'ok', secondsSince: null }
  const secondsSince = Math.max(0, Math.round((now - lastBeat) / 1000))
  return { level: secondsSince > staleSec ? 'lag' : 'ok', secondsSince }
}

/* ── shared formatting ─────────────────────────────────────────────── */

/** Language-neutral relative stamp ("42s" "5m" "2h" "3d"), Vercel-log style. */
export function agoText(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s'
  if (sec < 60) return `${Math.floor(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

/** Running-duration label for an in-flight card ("3m 12s"). */
export function durationText(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  if (m === 0) return `${s}s`
  return `${m}m ${String(s).padStart(2, '0')}s`
}
