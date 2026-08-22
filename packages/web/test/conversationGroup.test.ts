// packages/web/test/conversationGroup.test.ts — pure tests for sidebar
// conversation bucketing (📌置顶 first, 今天/昨天/近 7 天/更早 by local
// calendar day) and the bilingual (zh | en) relative-time formatter.
import { describe, expect, test } from 'vitest'
import { groupConversations, groupLabel, relTime, startOfDay } from '../src/sidebar/grouping'
import type { Conversation } from '../src/state/types'

let n = 0
const C = (over: Partial<Conversation> = {}): Conversation => ({
  id: over.id ?? `c${++n}`,
  title: over.title ?? `conv ${n}`,
  createdAt: over.createdAt ?? 0,
  updatedAt: over.updatedAt ?? 0,
  pinned: over.pinned ?? 0,
  gear: over.gear ?? 'balanced',
  model: over.model ?? 'deepseek-v4-flash',
  archived: over.archived ?? 0,
  messageCount: over.messageCount ?? 0,
  preview: over.preview ?? '',
})

// Fixed local-time anchor: 2026-08-21 (Friday) 20:00.
const NOW = new Date(2026, 7, 21, 20, 0, 0).getTime()
const at = (dayOffset: number, h = 12, m = 0): number =>
  new Date(2026, 7, 21 + dayOffset, h, m, 0).getTime()

describe('groupConversations', () => {
  test('buckets by local calendar day: today / yesterday / week / older', () => {
    const groups = groupConversations(
      [
        C({ id: 'today', updatedAt: at(0, 15) }),
        C({ id: 'yesterday', updatedAt: at(-1, 9) }),
        C({ id: 'd3', updatedAt: at(-3) }),
        C({ id: 'd6', updatedAt: at(-6) }), // still within 近 7 天
        C({ id: 'older', updatedAt: at(-20) }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'week', 'older'])
    expect(groups[0]!.items.map((c) => c.id)).toEqual(['today'])
    expect(groups[1]!.items.map((c) => c.id)).toEqual(['yesterday'])
    expect(groups[2]!.items.map((c) => c.id)).toEqual(['d3', 'd6']) // updatedAt desc
    expect(groups[3]!.items.map((c) => c.id)).toEqual(['older'])
  })

  test('pinned conversations come first, regardless of age', () => {
    const groups = groupConversations(
      [
        C({ id: 'fresh', updatedAt: at(0, 10) }),
        C({ id: 'ancient-pin', updatedAt: at(-90), pinned: 1 }),
      ],
      NOW,
    )
    expect(groups.map((g) => g.key)).toEqual(['pinned', 'today'])
    expect(groups[0]!.items.map((c) => c.id)).toEqual(['ancient-pin'])
  })

  test('sorts inside each bucket by updatedAt descending', () => {
    const groups = groupConversations(
      [
        C({ id: 'a', updatedAt: at(0, 9) }),
        C({ id: 'b', updatedAt: at(0, 18) }),
        C({ id: 'c', updatedAt: at(0, 12) }),
      ],
      NOW,
    )
    expect(groups[0]!.items.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  test('omits empty buckets and handles an empty list', () => {
    expect(groupConversations([], NOW)).toEqual([])
    const groups = groupConversations([C({ id: 'only', updatedAt: at(-2) })], NOW)
    expect(groups.map((g) => g.key)).toEqual(['week'])
  })

  test('same calendar day counts as today even before midnight-crossing deltas', () => {
    // 00:30 → 20:00 same day: delta > 12h but still 今天 bucket
    const groups = groupConversations([C({ id: 'early', updatedAt: at(0, 0, 30) })], NOW)
    expect(groups.map((g) => g.key)).toEqual(['today'])
  })

  test('exactly 7 days back falls into 更早', () => {
    const groups = groupConversations([C({ id: 'edge', updatedAt: at(-7) })], NOW)
    expect(groups.map((g) => g.key)).toEqual(['older'])
  })

  test('group labels follow the lang argument (zh default)', () => {
    const groups = groupConversations([C({ id: 'p', pinned: 1, updatedAt: at(0) })], NOW, 'en')
    expect(groups[0]!.label).toBe('📌 Pinned')
    expect(groupLabel('today', 'en')).toBe('Today')
    expect(groupLabel('week', 'en')).toBe('Last 7 days')
    expect(groupLabel('older', 'en')).toBe('Older')
    // default stays Chinese — the existing zh UI is unchanged
    expect(groupConversations([C({ id: 'p', pinned: 1 })], NOW)[0]!.label).toBe('📌 置顶')
  })
})

describe('relTime', () => {
  test('刚刚 under a minute', () => {
    expect(relTime(NOW - 10_000, NOW)).toBe('刚刚')
  })

  test('N分钟前 under an hour', () => {
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe('5分钟前')
    expect(relTime(NOW - 59 * 60_000, NOW)).toBe('59分钟前')
  })

  test('today beyond an hour → 今天 HH:MM', () => {
    expect(relTime(new Date(2026, 7, 21, 15, 0).getTime(), NOW)).toBe('今天 15:00')
  })

  test('yesterday → 昨天 14:30', () => {
    expect(relTime(new Date(2026, 7, 20, 14, 30).getTime(), NOW)).toBe('昨天 14:30')
  })

  test('2–6 days back → N天前', () => {
    expect(relTime(at(-3, 10), NOW)).toBe('3天前')
    expect(relTime(at(-6, 10), NOW)).toBe('6天前')
  })

  test('7+ days same year → M月D日', () => {
    expect(relTime(new Date(2026, 5, 9, 10).getTime(), NOW)).toBe('6月9日')
  })

  test('other years → YYYY/M/D', () => {
    expect(relTime(new Date(2025, 11, 30, 10).getTime(), NOW)).toBe('2025/12/30')
  })
})

describe('relTime (en)', () => {
  test('just now / N min ago', () => {
    expect(relTime(NOW - 10_000, NOW, 'en')).toBe('just now')
    expect(relTime(NOW - 5 * 60_000, NOW, 'en')).toBe('5 min ago')
  })

  test('Today / Yesterday keep the clock suffix', () => {
    expect(relTime(new Date(2026, 7, 21, 15, 0).getTime(), NOW, 'en')).toBe('Today 15:00')
    expect(relTime(new Date(2026, 7, 20, 14, 30).getTime(), NOW, 'en')).toBe('Yesterday 14:30')
  })

  test('N days ago, then short month + day within the year', () => {
    expect(relTime(at(-3, 10), NOW, 'en')).toBe('3 days ago')
    expect(relTime(new Date(2026, 5, 9, 10).getTime(), NOW, 'en')).toBe('Jun 9')
    expect(relTime(new Date(2025, 11, 30, 10).getTime(), NOW, 'en')).toBe('2025/12/30')
  })
})

describe('startOfDay', () => {
  test('zeroes time-of-day in the local zone', () => {
    const ts = new Date(2026, 7, 21, 23, 59, 59).getTime()
    const d = new Date(startOfDay(ts))
    expect(d.getHours()).toBe(0)
    expect(d.getDate()).toBe(21)
  })
})
