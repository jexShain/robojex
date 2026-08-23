// packages/web/src/sidebar/grouping.ts — pure conversation bucketing and
// relative-time formatting (本地时区), bilingual (zh | en) via an optional lang
// argument defaulting to zh. No DOM imports so it runs in vitest's node
// environment.

import type { Conversation } from '../state/types'
import type { Lang } from '../i18n/event'
import type { IconName } from '../ui/Icon'

export type GroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older'

export interface ConvGroup {
  key: GroupKey
  label: string
  items: Conversation[]
}

export const GROUP_ORDER: GroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older']

/** Chrome icon for each group heading (the sidebar renders it via <Icon/>);
 * null = text-only heading. Type-only import keeps this file DOM-free. */
export const GROUP_ICON: Record<GroupKey, IconName | null> = {
  pinned: 'pin',
  today: null,
  yesterday: null,
  week: null,
  older: null,
}

const GROUP_LABELS: Record<Lang, Record<GroupKey, string>> = {
  zh: {
    pinned: '置顶',
    today: '今天',
    yesterday: '昨天',
    week: '近 7 天',
    older: '更早',
  },
  en: {
    pinned: 'Pinned',
    today: 'Today',
    yesterday: 'Yesterday',
    week: 'Last 7 days',
    older: 'Older',
  },
}

/** Group heading in the requested language. */
export function groupLabel(key: GroupKey, lang: Lang = 'zh'): string {
  return GROUP_LABELS[lang][key]
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
 * Bucket conversations into 置顶(GROUP_ICON pin) / 今天 / 昨天 / 近 7 天 / 更早 (pinned first
 * regardless of age), each bucket sorted by updatedAt desc, empty buckets
 * omitted. Pure: `now` injectable for tests; labels follow `lang`.
 */
export function groupConversations(
  convs: Conversation[],
  now: number = Date.now(),
  lang: Lang = 'zh',
): ConvGroup[] {
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
    groups.push({ key, label: groupLabel(key, lang), items })
  }
  return groups
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Relative time, zh by default: 刚刚 / N分钟前 / 今天 HH:MM / 昨天 HH:MM /
 * N天前 / M月D日 / YYYY/M/D. English: just now / N min ago / Today HH:MM /
 * Yesterday HH:MM / N days ago / Aug 9 / YYYY/M/D. Pure: `now` injectable.
 */
export function relTime(ts: number, now: number = Date.now(), lang: Lang = 'zh'): string {
  const diff = now - ts
  if (diff < 60_000) return lang === 'en' ? 'just now' : '刚刚'
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000)
    return lang === 'en' ? `${mins} min ago` : `${mins}分钟前`
  }
  const d = new Date(ts)
  const n = new Date(now)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(ts)) / DAY)
  if (dayDiff === 0) return lang === 'en' ? `Today ${hm}` : `今天 ${hm}`
  if (dayDiff === 1) return lang === 'en' ? `Yesterday ${hm}` : `昨天 ${hm}`
  if (dayDiff < 7) return lang === 'en' ? `${dayDiff} days ago` : `${dayDiff}天前`
  if (d.getFullYear() === n.getFullYear()) {
    return lang === 'en'
      ? `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`
      : `${d.getMonth() + 1}月${d.getDate()}日`
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
