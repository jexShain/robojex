// packages/web/test/taskTransitions.test.ts — pins the T8 OS-toast diff:
// only genuine status jumps earn a toast, boot/reconnect stays silent.

import { describe, expect, it } from 'vitest'

import { diffTaskTransitions, snapshotStatuses } from '../src/state/taskTransitions'

const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  title: `task ${id}`,
  resultSummary: 'shipped',
  ...extra,
})

describe('diffTaskTransitions', () => {
  it('stays silent on the baseline snapshot (previous === null)', () => {
    const rows = [row('a', 'done'), row('b', 'blocked'), row('c', 'running')]
    expect(diffTaskTransitions(null, rows)).toEqual([])
  })

  it('toasts a running → done jump with the result summary as detail', () => {
    const prev = snapshotStatuses([row('a', 'running')])
    const events = diffTaskTransitions(prev, [row('a', 'done')])
    expect(events).toEqual([{ kind: 'done', title: 'task a', detail: 'shipped' }])
  })

  it('toasts todo → done too (a scheduled card that settled unseen)', () => {
    const prev = snapshotStatuses([{ id: 'a', status: 'todo' }])
    expect(diffTaskTransitions(prev, [row('a', 'done')])).toHaveLength(1)
  })

  it('does not re-toast a task that was already done', () => {
    const prev = snapshotStatuses([row('a', 'done')])
    expect(diffTaskTransitions(prev, [row('a', 'done')])).toEqual([])
  })

  it('toasts running → blocked, but not todo → blocked', () => {
    const prev = snapshotStatuses([
      { id: 'a', status: 'running' },
      { id: 'b', status: 'todo' },
    ])
    const events = diffTaskTransitions(prev, [
      { id: 'a', status: 'blocked', title: 'task a' },
      { id: 'b', status: 'blocked', title: 'task b' },
    ])
    expect(events).toEqual([{ kind: 'blocked', title: 'task a', detail: '' }])
  })

  it('never toasts a task the user cancelled, and forgets it quietly', () => {
    const prev = snapshotStatuses([row('a', 'running')])
    // cancelled rows are skipped by the diff itself
    expect(diffTaskTransitions(prev, [{ id: 'a', status: 'cancelled' }])).toEqual([])
  })

  it('a task absent from the new snapshot earns no toast (archived)', () => {
    const prev = snapshotStatuses([row('a', 'running')])
    expect(diffTaskTransitions(prev, [])).toEqual([])
  })

  it('new cards in a snapshot are not transitions', () => {
    const prev = snapshotStatuses([])
    expect(diffTaskTransitions(prev, [row('x', 'running')])).toEqual([])
  })

  it('tolerates malformed frames without throwing', () => {
    expect(diffTaskTransitions({}, undefined)).toEqual([])
    expect(diffTaskTransitions({}, [null, 7, { status: 'done' }])).toEqual([])
  })

  it('snapshotStatuses ignores junk rows', () => {
    expect(snapshotStatuses([null, { id: 'a' }, { id: 'b', status: 'running' }])).toEqual({ b: 'running' })
  })
})
