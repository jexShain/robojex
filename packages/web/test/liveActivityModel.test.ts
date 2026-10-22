// packages/web/test/liveActivityModel.test.ts — LiveActivity derivations:
// in-flight cards, completion dedupe, decision-stream filter, heartbeat.
import { describe, expect, test } from 'vitest'
import {
  agoText,
  decisionStream,
  durationText,
  heartbeat,
  isRunningStatus,
  lastBeatTs,
  recentCompletions,
  runningCards,
} from '../src/views/liveActivityModel'
import type { ActivityItem } from '../src/views/activityModel'
import type { Task } from '../src/state/types'

const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  status: 'todo',
  createdAt: 1000,
  ...over,
})

const item = (over: Partial<ActivityItem> & { id: string; type: ActivityItem['type'] }): ActivityItem => ({
  ts: 1000,
  icon: 'check',
  title: '',
  color: 'green',
  ...over,
})

describe('runningCards', () => {
  test('keeps running-family statuses and drops the rest', () => {
    expect(isRunningStatus('running')).toBe(true)
    expect(isRunningStatus('in_progress')).toBe(true)
    expect(isRunningStatus('Active')).toBe(true)
    expect(isRunningStatus('todo')).toBe(false)
    expect(isRunningStatus('done')).toBe(false)
    const cards = runningCards([
      task({ id: 'a', title: 'A', status: 'running' }),
      task({ id: 'b', title: 'B', status: 'done' }),
      task({ id: 'c', title: 'C', status: 'blocked' }),
    ])
    expect(cards.map((c) => c.id)).toEqual(['a'])
  })

  test('progress clamps to 0–100 and stays null when unknown', () => {
    const cards = runningCards([
      task({ id: 'a', title: 'A', status: 'running', progress: 42.6 }),
      task({ id: 'b', title: 'B', status: 'running', progress: -5 }),
      task({ id: 'c', title: 'C', status: 'running', progress: 240 }),
      task({ id: 'd', title: 'D', status: 'running' }),
    ])
    expect(cards.map((c) => c.progress)).toEqual([43, 0, 100, null])
  })

  test('newest-first (Vercel deploy-list order)', () => {
    const cards = runningCards([
      task({ id: 'old', title: 'old', status: 'running', createdAt: 100 }),
      task({ id: 'new', title: 'new', status: 'running', createdAt: 900 }),
    ])
    expect(cards.map((c) => c.id)).toEqual(['new', 'old'])
  })

  test('empty assignee becomes undefined (badge suppressed)', () => {
    const cards = runningCards([task({ id: 'a', title: 'A', status: 'running', assignee: '' })])
    expect(cards[0].assignee).toBeUndefined()
  })
})

describe('recentCompletions', () => {
  test('only done/blocked entries survive, newest-first, capped', () => {
    const items = [
      item({ id: '3', type: 'task_done', title: 'C', ts: 30 }),
      item({ id: '2', type: 'cycle', title: 'wake', ts: 25 }),
      item({ id: '1', type: 'task_blocked', title: 'B', ts: 20 }),
      item({ id: '0', type: 'task_done', title: 'A', ts: 10 }),
    ]
    expect(recentCompletions(items, 2).map((r) => r.title)).toEqual(['C', 'B'])
  })

  test('re-runs of one title collapse to the latest verdict', () => {
    const items = [
      item({ id: 'new', type: 'task_done', title: 'Fix flaky test', ts: 90, detail: 'green' }),
      item({ id: 'old', type: 'task_blocked', title: 'Fix flaky test', ts: 10, detail: 'boom' }),
    ]
    const rows = recentCompletions(items)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'new', tone: 'done', summary: 'green' })
  })

  test('titleless entries keep their own identity', () => {
    const rows = recentCompletions([
      item({ id: 'x', type: 'task_done', title: '', ts: 10 }),
      item({ id: 'y', type: 'task_done', title: '', ts: 20 }),
    ])
    expect(rows.map((r) => r.key)).toEqual(['y', 'x'])
  })
})

describe('decisionStream', () => {
  test('thinking/decision types pass; chat, tick and budget noise drops', () => {
    const items = [
      item({ id: 'a', type: 'think', title: 't' }),
      item({ id: 'b', type: 'cycle', title: 'c' }),
      item({ id: 'c', type: 'chat', title: 'hi' }),
      item({ id: 'd', type: 'tick', title: 'beat' }),
      item({ id: 'e', type: 'budget', title: 'tok' }),
      item({ id: 'f', type: 'mode', title: 'm' }),
    ]
    expect(decisionStream(items).map((i) => i.id)).toEqual(['a', 'b', 'f'])
  })

  test('capped at limit', () => {
    const items = Array.from({ length: 70 }, (_, i) => item({ id: `i${i}`, type: 'think' }))
    expect(decisionStream(items, 60)).toHaveLength(60)
  })
})

describe('heartbeat', () => {
  const NOW = 10_000_000

  test('last beat is the newest tick/cycle item', () => {
    expect(
      lastBeatTs([
        item({ id: 'a', type: 'chat', ts: NOW }),
        item({ id: 'b', type: 'cycle', ts: NOW - 5000 }),
        item({ id: 'c', type: 'tick', ts: NOW - 9000 }),
      ]),
    ).toBe(NOW - 5000)
    expect(lastBeatTs([item({ id: 'a', type: 'chat', ts: NOW })])).toBeNull()
  })

  test('WS not live ⇒ down regardless of beats', () => {
    expect(heartbeat('reconnecting', NOW - 1000, NOW).level).toBe('down')
    expect(heartbeat('connecting', null, NOW)).toEqual({ level: 'down', secondsSince: null })
  })

  test('live but silent past the staleness window ⇒ lag', () => {
    const hb = heartbeat('live', NOW - 120_000, NOW)
    expect(hb.level).toBe('lag')
    expect(hb.secondsSince).toBe(120)
  })

  test('fresh beat (or no beat yet while live) ⇒ ok', () => {
    expect(heartbeat('live', NOW - 5_000, NOW)).toEqual({ level: 'ok', secondsSince: 5 })
    expect(heartbeat('live', null, NOW)).toEqual({ level: 'ok', secondsSince: null })
  })
})

describe('log stamps', () => {
  test('agoText steps through s/m/h/d', () => {
    expect(agoText(7)).toBe('7s')
    expect(agoText(65)).toBe('1m')
    expect(agoText(7200)).toBe('2h')
    expect(agoText(172800)).toBe('2d')
    expect(agoText(-3)).toBe('0s')
  })

  test('durationText renders m/s for in-flight cards', () => {
    expect(durationText(45)).toBe('45s')
    expect(durationText(192)).toBe('3m 12s')
  })
})
