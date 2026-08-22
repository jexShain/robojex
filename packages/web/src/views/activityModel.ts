// packages/web/src/views/activityModel.ts — pure functions that ingest raw
// WebSocket frames and produce ActivityItem[] for the ActivityFeed panel.

export type ActivityItem = {
  id: string
  ts: number
  type: 'cycle' | 'spawn' | 'task_done' | 'task_blocked' | 'chat' | 'mode' | 'budget' | 'tick' | 'think'
  icon: string
  /** Dynamic text (task titles, budget lines) — rendered as-is, untranslated. */
  title: string
  /** i18n key for fixed labels (act.*); takes precedence over `title`. */
  labelKey?: string
  /** Value interpolated into labelKey templates as {n}. */
  labelParam?: string | number
  detail?: string
  color: string
}

const MAX_ITEMS = 200

/** Format an epoch-ms timestamp as HH:MM:SS. */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** Derive an activity item from a single cycle action. Returns null when the
 *  action is not interesting enough to surface as a standalone entry. Fixed
 *  labels carry a labelKey (translated at render); dynamic titles stay raw. */
function actionToItem(a: { type: string; text?: string; title?: string; [key: string]: unknown }, ts: number): ActivityItem | null {
  switch (a.type) {
    case 'spawn':
      return {
        id: `spawn-${ts}-${String(a.title ?? '').slice(0, 20)}`,
        ts,
        type: 'spawn',
        icon: '●',
        title: a.title ?? '',
        labelKey: a.title ? undefined : 'act.spawned',
        detail: typeof a.framework === 'string' ? a.framework : undefined,
        color: 'green',
      }
    case 'task_done':
      return {
        id: `task_done-${ts}-${String(a.title ?? '').slice(0, 20)}`,
        ts,
        type: 'task_done',
        icon: '✓',
        title: a.title ?? '',
        labelKey: a.title ? undefined : 'act.done',
        detail: typeof a.summary === 'string' ? a.summary : a.text,
        color: 'green',
      }
    case 'task_blocked':
      return {
        id: `task_blocked-${ts}-${String(a.title ?? '').slice(0, 20)}`,
        ts,
        type: 'task_blocked',
        icon: '✗',
        title: a.title ?? '',
        labelKey: a.title ? undefined : 'act.blocked',
        detail: typeof a.error === 'string' ? a.error : a.text,
        color: 'red',
      }
    case 'chat':
      return {
        id: `chat-${ts}`,
        ts,
        type: 'chat',
        icon: '●',
        title: '',
        labelKey: 'act.replied',
        detail: typeof a.text === 'string' ? a.text : undefined,
        color: 'purple',
      }
    case 'think':
      return {
        id: `think-${ts}`,
        ts,
        type: 'think',
        icon: '●',
        title: '',
        labelKey: 'act.thinking',
        color: 'blue',
      }
    default:
      return null
  }
}

/** Ingest a single server frame and return the updated activity list.
 *  New items are prepended (newest-first) and the list is capped at 200. */
export function ingestFrame(frame: Record<string, unknown>, items: ActivityItem[]): ActivityItem[] {
  const incoming: ActivityItem[] = []
  const now = Date.now()
  const t = frame.t as string | undefined

  if (t === 'cycle') {
    const wake = typeof frame.wake === 'number' ? frame.wake : 0
    const cost = typeof frame.cost === 'number' ? frame.cost : 0
    incoming.push({
      id: `cycle-${now}-${wake}`,
      ts: now,
      type: 'cycle',
      icon: '●',
      title: '',
      labelKey: 'act.wake',
      labelParam: wake,
      detail: cost > 0 ? `${Math.round(cost)} tok` : undefined,
      color: 'blue',
    })

    // Surface interesting cycle actions as separate items.
    const actions = Array.isArray(frame.actions) ? frame.actions : []
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i] as { type: string; text?: string; title?: string; [key: string]: unknown }
      const item = actionToItem(a, now)
      if (item) incoming.push(item)
    }
  } else if (t === 'chat_out') {
    const from = frame.from as string | undefined
    if (from === 'jex') {
      const text = typeof frame.text === 'string' ? frame.text : ''
      incoming.push({
        id: `chat-${now}-${text.slice(0, 20)}`,
        ts: now,
        type: 'chat',
        icon: '●',
        title: '',
        labelKey: 'act.replied',
        detail: text || undefined,
        color: 'purple',
      })
    }
  } else if (t === 'mode') {
    const mode = typeof frame.mode === 'string' ? frame.mode : '?'
    incoming.push({
      id: `mode-${now}`,
      ts: now,
      type: 'mode',
      icon: '●',
      title: '',
      labelKey: 'act.modeLine',
      labelParam: mode,
      color: 'amber',
    })
  } else if (t === 'budget') {
    const line = typeof frame.line === 'string' ? frame.line : ''
    if (line) {
      incoming.push({
        id: `budget-${now}`,
        ts: now,
        type: 'budget',
        icon: '●',
        title: line,
        color: 'dim',
      })
    }
  } else if (t === 'tasks') {
    // Scan tasks for status changes → task_done / task_blocked
    const tasks = Array.isArray(frame.tasks) ? frame.tasks : []
    for (const raw of tasks) {
      const task = raw as { title?: string; status?: string; resultSummary?: string; [key: string]: unknown }
      const status = typeof task.status === 'string' ? task.status.toLowerCase() : ''
      if (status.includes('done') || status.includes('complete') || status.includes('success')) {
        incoming.push({
          id: `task_done-${now}-${String(task.title ?? '').slice(0, 20)}`,
          ts: now,
          type: 'task_done',
          icon: '✓',
          title: task.title ?? '',
          labelKey: task.title ? undefined : 'act.done',
          detail: typeof task.resultSummary === 'string' ? task.resultSummary : undefined,
          color: 'green',
        })
      } else if (status.includes('fail') || status.includes('error') || status.includes('block')) {
        incoming.push({
          id: `task_blocked-${now}-${String(task.title ?? '').slice(0, 20)}`,
          ts: now,
          type: 'task_blocked',
          icon: '✗',
          title: task.title ?? '',
          labelKey: task.title ? undefined : 'act.blocked',
          color: 'red',
        })
      }
    }
  } else if (t === 'tick') {
    incoming.push({
      id: `tick-${now}`,
      ts: now,
      type: 'tick',
      icon: '●',
      title: '',
      labelKey: 'act.heartbeat',
      color: 'dim',
    })
  }

  if (incoming.length === 0) return items

  // New items are already in reverse-chronological within the batch.
  // Prepend them before the existing items.
  const merged = [...incoming, ...items]
  return merged.length > MAX_ITEMS ? merged.slice(0, MAX_ITEMS) : merged
}
