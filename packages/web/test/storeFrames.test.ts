// packages/web/test/storeFrames.test.ts — WS frame resilience (t_34df9d82).
// applyFrame used to fall off the switch end for unlisted frame types and
// return undefined: one unknown core frame ({t:'tick'} …) replaced the whole
// app state and blanked the page until the next full hello replay. These
// tests pin the no-op contract (plus the warn) and the policy-frame plumbing.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// store.tsx pulls theme.ts, which registers a listener on window at module
// load. The suite runs in node (no jsdom in this repo); a minimal stub keeps
// module evaluation honest without a new devDependency.
vi.hoisted(() => {
  if (typeof (globalThis as Record<string, unknown>).window === 'undefined') {
    ;(globalThis as Record<string, unknown>).window = {
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }
  }
})

import { initialState, reducer } from '../src/state/store'
import type { ServerFrame, StateSnapshot } from '../src/state/types'

const helloFrame: ServerFrame = {
  t: 'hello',
  state: {
    now: 1_700_000_000_000,
    tasks: [{ id: 't1', title: 'watch the board', status: 'running', createdAt: 1, progress: 42 }],
    budget: { mode: 'budgeted', dailyTokens: 1_000_000, spentToday: 1234, line: '12%' },
    mode: 'full',
    policy: 'butler',
    mission: 'ship it',
    rubric: 'r',
    memory: 'm',
    chat: [{ from: 'jex', text: 'hello from the ring', ts: 1 }],
    version: '9.9.9',
  } satisfies StateSnapshot,
}

/** Seed a rich, non-initial state through the real hello path. */
const seed = () => reducer(initialState, { type: 'frame', frame: helloFrame })

describe('applyFrame unknown-frame resilience', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  test('hello seeds the state the no-op assertions below check', () => {
    const s = seed()
    expect(s.version).toBe('9.9.9')
    expect(s.tasks).toHaveLength(1)
    expect(s.transcript.length).toBeGreaterThan(0)
    expect(s.policy).toBe('butler')
  })

  test('unknown {t:"tick"} frame is a state-preserving no-op', () => {
    const before = seed()
    const after = reducer(before, { type: 'frame', frame: { t: 'tick' } as unknown as ServerFrame })
    expect(after).toBe(before) // same reference: nothing was replaced
    expect(after.version).toBe('9.9.9')
    expect(after.tasks).toHaveLength(1)
    expect(after.tasks[0].title).toBe('watch the board')
    expect(after.transcript.length).toBeGreaterThan(0)
    expect(after.conn).toBe('connecting') // untouched sibling fields too
  })

  test('unknown frame names the frame on console.warn', () => {
    const before = seed()
    reducer(before, { type: 'frame', frame: { t: 'mystery_frame' } as unknown as ServerFrame })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('mystery_frame')
  })

  test('a burst of unknown frames never degrades later known frames', () => {
    const before = seed()
    let s = before
    for (const t of ['tick', 'policy_v2', 'tick', 'heartbeat']) {
      s = reducer(s, { type: 'frame', frame: { t } as unknown as ServerFrame })
    }
    expect(s).toBe(before) // storm survived: same reference, zero drift
    // known frames still land afterwards
    s = reducer(s, { type: 'frame', frame: { t: 'mode', mode: 'assist' } })
    expect(s.mode).toBe('assist')
    expect(s.tasks).toHaveLength(1)
  })

  test('reconnect (hello replay) restores full state after an unknown storm', () => {
    let s = seed()
    s = reducer(s, { type: 'frame', frame: { t: 'tick' } as unknown as ServerFrame })
    s = reducer(s, { type: 'conn', conn: 'reconnecting' })
    s = reducer(s, { type: 'frame', frame: helloFrame })
    expect(s.version).toBe('9.9.9')
    expect(s.tasks).toHaveLength(1)
    expect(s.conn).toBe('reconnecting') // conn is not a frame field; hello leaves it
  })
})

describe('policy frame (vocabulary drift closed: core sends it since T3)', () => {
  test('hello snapshot seeds policy', () => {
    expect(seed().policy).toBe('butler')
  })

  test('hello from an older core (no policy field) resets to null', () => {
    const stale = seed()
    expect(stale.policy).toBe('butler')
    const frame = {
      t: 'hello',
      state: { ...helloFrame.state, policy: undefined },
    } as ServerFrame
    expect(reducer(stale, { type: 'frame', frame }).policy).toBeNull()
  })

  test('live policy frame updates without touching other fields', () => {
    const before = seed()
    const after = reducer(before, { type: 'frame', frame: { t: 'policy', policy: 'conservative' } })
    expect(after.policy).toBe('conservative')
    expect(after.tasks).toBe(before.tasks)
    expect(after.transcript).toBe(before.transcript)
    expect(after.mode).toBe('full')
  })

  test('no-op policy frame keeps the state reference stable', () => {
    const before = seed()
    expect(reducer(before, { type: 'frame', frame: { t: 'policy', policy: 'butler' } })).toBe(before)
  })
})
