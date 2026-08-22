// packages/web/test/butlerNotice.test.ts — pure tests for the butler-
// briefing pipeline: routeNotice (where an inbound jex chat_out lands — the
// decision table over lastAgent / active / butler conversation refs, stale
// refs treated as absent), the reducer-level unread lifecycle (park → count
// → clear on open → splice on load), and the OS-notification pref parser.
// sysNotify itself is a thin try/catch bridge shim over window.robojex —
// not unit-testable in node and covered by usage instead.
import { describe, expect, test, vi } from 'vitest'

// theme.ts touches window at module scope; the reducer tests run in node
vi.mock('../src/state/theme', () => ({
  setThemePref: vi.fn(),
  themeSnapshot: () => ({ pref: 'dark', resolved: 'dark' }),
}))

import { initialState, reducer, routeNotice } from '../src/state/store'
import { parseNotifySys } from '../src/state/api'
import type { Conversation, Message } from '../src/state/types'

const conv = (id: string): Conversation => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  pinned: 0,
  gear: '',
  model: '',
  archived: 0,
  messageCount: 0,
  preview: '',
})

const serverMsg = (id: string, convId: string): Message => ({
  id,
  convId,
  role: 'user',
  content: 'history',
  createdAt: 1,
})

describe('routeNotice — briefing landing decision table', () => {
  const convs = [conv('agent'), conv('open'), conv('butler')]

  test('1. lastAgentConvId wins while its conversation exists', () => {
    const r = routeNotice({ conversations: convs, activeConvId: 'open' }, 'agent', 'butler')
    expect(r).toEqual({ convId: 'agent', create: false })
  })

  test('2. stale /jex ref falls to the currently open conversation', () => {
    const r = routeNotice({ conversations: convs, activeConvId: 'open' }, 'ghost', 'butler')
    expect(r).toEqual({ convId: 'open', create: false })
  })

  test('2b. no /jex ref at all also uses the open conversation', () => {
    const r = routeNotice({ conversations: convs, activeConvId: 'open' }, null, null)
    expect(r).toEqual({ convId: 'open', create: false })
  })

  test('3. nothing open reuses the butler-report conversation', () => {
    const r = routeNotice({ conversations: convs, activeConvId: null }, null, 'butler')
    expect(r).toEqual({ convId: 'butler', create: false })
  })

  test('4. every ref missing (or stale) demands creation', () => {
    expect(routeNotice({ conversations: convs, activeConvId: null }, null, null)).toEqual({
      convId: null,
      create: true,
    })
    // a butler conv deleted server-side must not resurrect as a target
    expect(routeNotice({ conversations: convs, activeConvId: null }, null, 'ghost')).toEqual({
      convId: null,
      create: true,
    })
  })

  test('a stale activeConvId (deleted while referenced) does not win over the butler conv', () => {
    const r = routeNotice({ conversations: convs, activeConvId: 'ghost' }, null, 'butler')
    expect(r).toEqual({ convId: 'butler', create: false })
  })
})

describe('agent-notice — unread lifecycle at the reducer', () => {
  function boot(active: string | null): typeof initialState {
    return { ...initialState, conversations: [conv('open'), conv('quiet'), conv('other')], activeConvId: active }
  }

  test('briefing for a closed conversation parks + counts unread, live view untouched', () => {
    let s = boot('open')
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: '任务A完成' })
    expect(s.unread).toEqual({ quiet: 1 })
    expect(s.notices.quiet).toHaveLength(1)
    expect(s.notices.quiet?.[0]).toMatchObject({ role: 'notice', kind: 'agent-notice', content: '任务A完成' })
    expect(s.messages).toEqual([])
    // sidebar surfacing: recency bump + preview of the latest briefing
    const quiet = s.conversations.find((c) => c.id === 'quiet')
    expect(quiet?.preview).toBe('任务A完成')
    expect(quiet?.updatedAt).toBeGreaterThan(0)
    // the open conversation's row is untouched
    expect(s.conversations.find((c) => c.id === 'open')?.updatedAt).toBe(0)
  })

  test('keeps counting — a second parked briefing reaches 2', () => {
    let s = boot('open')
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: '一' })
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: '二' })
    expect(s.unread.quiet).toBe(2)
    expect(s.notices.quiet).toHaveLength(2)
  })

  test('briefing for the OPEN conversation renders live with no unread', () => {
    let s = boot('open')
    s = reducer(s, { type: 'agent-notice', convId: 'open', text: '正在看' })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]?.kind).toBe('agent-notice')
    expect(s.unread).toEqual({})
    expect(s.notices).toEqual({})
  })

  test('opening clears the badge immediately (optimistic), buffer kept for the load', () => {
    let s = boot(null)
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: 'x' })
    s = reducer(s, { type: 'conv-selected', id: 'quiet', messages: [] })
    expect(s.activeConvId).toBe('quiet')
    expect(s.unread).toEqual({})
    expect(s.notices.quiet).toHaveLength(1) // still parked until messages load
  })

  test('loaded selection splices parked cards after the server history and retires the buffer', () => {
    let s = boot(null)
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: '第一条' })
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: '第二条' })
    const parkedIds = (s.notices.quiet ?? []).map((m) => m.id)
    s = reducer(s, { type: 'conv-selected', id: 'quiet', messages: [] })
    s = reducer(s, {
      type: 'conv-selected',
      id: 'quiet',
      messages: [serverMsg('m1', 'quiet')],
      loaded: true,
    })
    expect(s.messages.map((m) => m.id)).toEqual(['m1', ...parkedIds])
    expect(s.messages.map((m) => m.content)).toEqual(['history', '第一条', '第二条'])
    expect(s.notices).toEqual({})
    expect(s.unread).toEqual({})
  })

  test('opening one conversation leaves other badges untouched', () => {
    let s = boot(null)
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: 'a' })
    s = reducer(s, { type: 'agent-notice', convId: 'other', text: 'b' })
    s = reducer(s, { type: 'conv-selected', id: 'quiet', messages: [], loaded: true })
    expect(s.unread).toEqual({ other: 1 })
    expect(s.notices.quiet).toBeUndefined()
    expect(s.notices.other).toHaveLength(1)
  })

  test('deleting a conversation drops its badge + parked cards', () => {
    let s = boot('open')
    s = reducer(s, { type: 'agent-notice', convId: 'quiet', text: 'soon gone' })
    s = reducer(s, { type: 'conv-deleted', id: 'quiet' })
    expect(s.unread).toEqual({})
    expect(s.notices).toEqual({})
    expect(s.conversations.map((c) => c.id)).toEqual(['open', 'other'])
  })
})

describe('parseNotifySys', () => {
  test('defaults ON; only the exact "0" disables', () => {
    expect(parseNotifySys(null)).toBe(true)
    expect(parseNotifySys('1')).toBe(true)
    expect(parseNotifySys('off')).toBe(true)
    expect(parseNotifySys('0')).toBe(false)
  })
})
