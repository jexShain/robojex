// packages/web/test/streamStop.test.ts — regression for the stop-stream P0.5:
// POST /api/conversations returns a Conversation WITHOUT preview/messageCount,
// and an early stop leaves the streaming assistant's content as ''. The old
// `lastMsg?.content || conv.preview` then fell through to undefined and
// `.slice(0, 80)` crashed mid-dispatch, unmounting the tree (PAGE-ERROR +
// streamed content visually lost). The reducer must survive and keep the
// partial content / reasoning with streaming cleared.
import { describe, expect, test, vi } from 'vitest'

// theme.ts touches window at module scope; the reducer tests run in node
vi.mock('../src/state/theme', () => ({
  setThemePref: vi.fn(),
  themeSnapshot: () => ({ pref: 'dark', resolved: 'dark' }),
}))

import { initialState, reducer } from '../src/state/store'
import type { Conversation } from '../src/state/types'

/** Mirrors chat-store.create(): no preview, no messageCount in the payload. */
const freshConv = (): Conversation =>
  ({
    id: 'c1',
    title: '新对话',
    createdAt: 0,
    updatedAt: 0,
    pinned: 0,
    gear: 'balanced',
    model: '',
    archived: 0,
    messageCount: undefined,
    preview: undefined,
  }) as unknown as Conversation

describe('stream-done after an aborted stream', () => {
  test('keeps partial content+reasoning and never throws on a missing preview', () => {
    let s = { ...initialState, conversations: [freshConv()], activeConvId: 'c1' }
    s = reducer(s, { type: 'stream-start', convId: 'c1' })
    s = reducer(s, { type: 'stream-meta', convId: 'c1', userMsgId: 'u1', assistantMsgId: 'a1', model: 'm' })
    s = reducer(s, { type: 'stream-delta', convId: 'c1', field: 'reasoning', delta: '已流出的思考' })
    s = reducer(s, { type: 'stream-delta', convId: 'c1', field: 'content', delta: '已流出的' })
    // abort maps to a done event; the fresh conversation has NO preview field
    expect(() => reducer(s, { type: 'stream-done', convId: 'c1' })).not.toThrow()
    s = reducer(s, { type: 'stream-done', convId: 'c1' })

    const a = s.messages.find((m) => m.id === 'a1')
    expect(a?.content).toBe('已流出的')
    expect(a?.reasoning).toBe('已流出的思考')
    expect(a?.streaming).toBeFalsy()
    expect(s.stream.status).toBe('idle')
    expect(s.stream.convId).toBeNull()
    expect(s.conversations[0]?.preview).toBe('已流出的')
    expect(Number.isFinite(s.conversations[0]?.messageCount)).toBe(true)
  })

  test('reasoning-only stop (content still empty) also lands safely', () => {
    let s = { ...initialState, conversations: [freshConv()], activeConvId: 'c1' }
    s = reducer(s, { type: 'stream-start', convId: 'c1' })
    s = reducer(s, { type: 'stream-meta', convId: 'c1', userMsgId: 'u1', assistantMsgId: 'a2', model: 'm' })
    s = reducer(s, { type: 'stream-delta', convId: 'c1', field: 'reasoning', delta: 'only thinking so far' })
    expect(() => reducer(s, { type: 'stream-done', convId: 'c1' })).not.toThrow()
    s = reducer(s, { type: 'stream-done', convId: 'c1' })
    expect(s.messages.find((m) => m.id === 'a2')?.reasoning).toBe('only thinking so far')
    expect(s.conversations[0]?.preview).toBe('')
  })
})

describe('agent timeline cards', () => {
  test('append only into the live view of the target conversation', () => {
    let s = { ...initialState, conversations: [freshConv()], activeConvId: 'c1' }
    s = reducer(s, { type: 'agent-msg', convId: 'c1', kind: 'agent-send', text: '去查一下邮件' })
    s = reducer(s, { type: 'agent-msg', convId: 'c1', kind: 'agent-notice', text: '已安排 sub-agent 处理' })
    expect(s.messages.map((m) => [m.kind, m.content])).toEqual([
      ['agent-send', '去查一下邮件'],
      ['agent-notice', '已安排 sub-agent 处理'],
    ])
    // a reply aimed at another conversation never leaks into the open one
    s = reducer(s, { type: 'agent-msg', convId: 'other', kind: 'agent-notice', text: 'elsewhere' })
    expect(s.messages).toHaveLength(2)
  })
})
