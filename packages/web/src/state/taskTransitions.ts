// packages/web/src/state/taskTransitions.ts — pure diff over the tasks
// snapshot frame (t === 'tasks') for the desktop OS-toast rule (T8):
// a task that ENTERS done or blocked/crashed since the previous snapshot
// earns one native notification; the board itself only shows the current
// grid, so a transition the user never saw would otherwise go silent.
// Kept dependency-free so packages/web/test/taskTransitions.test.ts can
// pin the diff semantics without React or the bridge.

/** Minimal slice of a task row the diff cares about (server Task shape). */
export interface TaskSnapshotRow {
  id: string
  status: string
  title?: string
  resultSummary?: string
}

/** One notification-worthy transition found in this snapshot. */
export interface TaskTransition {
  kind: 'done' | 'blocked'
  title: string
  detail: string
}

/** Snapshot rows keyed by task id — the caller keeps one per connection
 *  (ref) and feeds every `tasks` frame through diffTaskTransitions. */
export function snapshotStatuses(rows: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(rows)) return out
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Partial<TaskSnapshotRow>
    if (typeof t.id === 'string' && typeof t.status === 'string') out[t.id] = t.status
  }
  return out
}

/**
 * Compare the new snapshot against the previous one.
 * - previous === null → baseline (first snapshot after boot): no events,
 *   so reconnecting never re-toasts the whole board.
 * - X → done: toast once, when the previous status was not done.
 * - running → blocked: toast only from an ACTIVE status; todo → blocked
 *   (a just-created card that failed validation) is not news yet.
 * - cancelled: silently forgotten (the user removed it; no surprise toast).
 * Titles/details are returned raw — the caller translates and clips.
 */
export function diffTaskTransitions(
  previous: Record<string, string> | null,
  rows: unknown,
): TaskTransition[] {
  const events: TaskTransition[] = []
  if (previous === null) return events
  if (!Array.isArray(rows)) return events
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Partial<TaskSnapshotRow>
    if (typeof t.id !== 'string' || typeof t.status !== 'string') continue
    const before = previous[t.id]
    if (before === undefined || before === t.status) continue // new card or no change
    const after = t.status.toLowerCase()
    if (after === 'done') {
      if (before.toLowerCase() !== 'done') {
        events.push({
          kind: 'done',
          title: typeof t.title === 'string' ? t.title : '',
          detail: typeof t.resultSummary === 'string' ? t.resultSummary : '',
        })
      }
    } else if (after === 'blocked') {
      if (before.toLowerCase() === 'running') {
        events.push({ kind: 'blocked', title: typeof t.title === 'string' ? t.title : '', detail: '' })
      }
    }
  }
  return events
}
