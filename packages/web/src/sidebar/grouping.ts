// packages/web/src/sidebar/grouping.ts — pure conversation bucketing and
// Chinese relative-time formatting (本地时区). No DOM imports so it runs in
// vitest's node environment.

import type { Conversation } from '../state/types'

export type GroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

export interface ConvGroup {
  key: GroupKey
  label: string
  items: Conversation[]
}

export const GROUP_ORDER: GroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older']

export const GROUP_LABELS: Record<GroupKey, string> = {
  pinned: '📌 置顶',
  today: '今天',
  yesterday: '昨天',
  week: '近 7 天',
  older: '更早',
}

const DAY = 86_400_000

/** Local-midnight timestamp of `ts` (time-of-day zeroed in the local zone). */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function bucketOf(c: Conversation, today0: number): GroupKey {
  if (c.pinned === 1) return 'pinned'
  const ts = c.updatedAt || c.createdAt || today0
  if (ts >= today0) return 'today'
  if (ts >= today0 - DAY) return 'yesterday'
  // 近 7 天 = today plus the previous 6 calendar days (dayDiff 1..6)
  if (ts >= today0 - 6 * DAY) return 'week'
  return 'older'
}

/**
 * Bucket conversations into 📌置顶 / 今天 / 昨天 / 近 7 天 / 更早 (pinned first
 * regardless of age), each bucket sorted by updatedAt desc, empty buckets
 * omitted. Pure: `now` injectable for tests.
 */
export function groupConversations(convs: Conversation[], now: number = Date.now()): ConvGroup[] {
  const today0 = startOfDay(now)
  const buckets = new Map<GroupKey, Conversation[]>()
  for (const key of GROUP_ORDER) buckets.set(key, [])
  for (const c of convs) {
    const key = bucketOf(c, today0)
    buckets.get(key)!.push(c)
  }
  const groups: ConvGroup[] = []
  for (const key of GROUP_ORDER) {
    const items = buckets.get(key)!
    if (items.length === 0) continue
    items.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    groups.push({ key, label: GROUP_LABELS[key], items })
  }
  return groups
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Chinese relative time: 刚刚 / N分钟前 / 今天 HH:MM / 昨天 HH:MM / N天前 /
 * M月D日 / YYYY/M/D. Pure: `now` injectable.
 */
export function relTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  const d = new Date(ts)
  const n = new Date(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(ts)) / DAY)
  if (dayDiff === 0) return `今天 ${hm}`
  if (dayDiff === 1) return `昨天 ${hm}`
  if (dayDiff < 7) return `${dayDiff}天前`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
