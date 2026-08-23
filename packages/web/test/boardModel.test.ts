// packages/web/test/boardModel.test.ts — pure geometry/forest tests for the
// Board view (tidy-tree layout, filters, blocked bubbling, edge paths).
import { describe, expect, test } from 'vitest'
import {
  CARD_H,
  CARD_W,
  LAYER_GAP,
  ROW_GAP,
  buildForest,
  edgePath,
  filterForest,
  layoutForest,
  parentIds,
} from '../src/views/boardModel'
import { DAY_MS, dayStartOf, fmtClock, fmtStamp } from '../src/views/timefmt'
import type { Task } from '../src/state/types'

let n = 0
const T = (over: Partial<Task> = {}): Task => ({
  id: over.id ?? `t${++n}`,
  title: over.title ?? `task ${n}`,
  status: over.status ?? 'todo',
  resultSummary: over.resultSummary ?? '',
  createdAt: over.createdAt ?? 1_000 + n,
  parentId: over.parentId ?? null,
  scheduledAt: over.scheduledAt ?? null,
  dueAt: over.dueAt ?? null,
})

describe('buildForest', () => {
  test('nests by parentId, orders siblings by createdAt, assigns depth', () => {
    const forest = buildForest([
      T({ id: 'a', createdAt: 3 }),
      T({ id: 'b', parentId: 'a', createdAt: 2 }),
      T({ id: 'c', parentId: 'a', createdAt: 1 }),
    ])
    expect(forest.map((r) => r.task.id)).toEqual(['a'])
    expect(forest[0]!.children.map((c) => c.task.id)).toEqual(['c', 'b'])
    expect(forest[0]!.children[1]!.depth).toBe(1)
  })

  test('orphan with dangling parentId surfaces as a root', () => {
    const forest = buildForest([T({ id: 'x', parentId: 'ghost' })])
    expect(forest.map((r) => r.task.id)).toEqual(['x'])
  })

  test('parent-cycle members and self-references surface as roots — none drop out', () => {
    const forest = buildForest([
      T({ id: 'r' }),
      T({ id: 'a', parentId: 'b' }),
      T({ id: 'b', parentId: 'a' }),
      T({ id: 'self', parentId: 'self' }),
    ])
    const rootIds = forest.map((x) => x.task.id).sort()
    expect(rootIds).toEqual(['a', 'b', 'r', 'self'])
    // cycle members are detached from their nominal parents
    const layout = layoutForest(forest, new Set())
    expect(layout.nodes.map((p) => p.node.task.id).sort()).toEqual(['a', 'b', 'r', 'self'])
  })

  test('blocked bubbles up to ancestors but not sideways', () => {
    const forest = buildForest([
      T({ id: 'root' }),
      T({ id: 'a', parentId: 'root' }),
      T({ id: 'a1', parentId: 'a' }),
      T({ id: 'a2', parentId: 'a', status: 'blocked' }),
      T({ id: 'b', parentId: 'root' }),
    ])
    const byId = (f: typeof forest, id: string) => {
      const stack = [...f]
      while (stack.length) {
        const cur = stack.pop()!
        if (cur.task.id === id) return cur
        stack.push(...cur.children)
      }
      throw new Error(`no node ${id}`)
    }
    expect(byId(forest, 'a2').subtreeBlocked).toBe(true)
    expect(byId(forest, 'a').subtreeBlocked).toBe(true)
    expect(byId(forest, 'root').subtreeBlocked).toBe(true)
    expect(byId(forest, 'b').subtreeBlocked).toBe(false)
  })
})

describe('layoutForest', () => {
  test('single task degrades to one card with no edges', () => {
    const lay = layoutForest(buildForest([T()]), new Set())
    expect(lay.nodes).toHaveLength(1)
    expect(lay.edges).toHaveLength(0)
    expect(lay.width).toBe(CARD_W)
    expect(lay.height).toBe(CARD_H)
  })

  test('childless roots stack vertically at x=0 with ROW_GAP', () => {
    const lay = layoutForest(buildForest([T(), T(), T()]), new Set())
    expect(lay.nodes.map((p) => p.x)).toEqual([0, 0, 0])
    expect(lay.nodes[1]!.y - lay.nodes[0]!.y).toBe(CARD_H + ROW_GAP)
    expect(lay.edges).toHaveLength(0)
  })

  test('parent centers between first and last child; columns advance by depth', () => {
    const lay = layoutForest(
      buildForest([
        T({ id: 'p' }),
        T({ id: 'c1', parentId: 'p' }),
        T({ id: 'c2', parentId: 'p' }),
      ]),
      new Set(),
    )
    const p = lay.nodes.find((x) => x.node.task.id === 'p')!
    const c1 = lay.nodes.find((x) => x.node.task.id === 'c1')!
    const c2 = lay.nodes.find((x) => x.node.task.id === 'c2')!
    expect(p.y).toBe((c1.y + c2.y) / 2)
    expect(c1.x - p.x).toBe(CARD_W + LAYER_GAP)
    expect(lay.edges).toHaveLength(2)
    expect(lay.edges[0]!.d.startsWith(`M ${CARD_W} `)).toBe(true)
  })

  test('collapsed parent hides its subtree and drops their edges', () => {
    const forest = buildForest([
      T({ id: 'p' }),
      T({ id: 'c', parentId: 'p' }),
      T({ id: 'g', parentId: 'c' }),
    ])
    const open = layoutForest(forest, new Set())
    expect(open.nodes).toHaveLength(3)
    expect(open.edges).toHaveLength(2)
    const shut = layoutForest(forest, new Set(['p']))
    expect(shut.nodes.map((x) => x.node.task.id)).toEqual(['p'])
    expect(shut.edges).toHaveLength(0)
  })

  test('parentIds lists every expandable node', () => {
    const forest = buildForest([T({ id: 'p' }), T({ id: 'c', parentId: 'p' })])
    expect(parentIds(forest)).toEqual(['p'])
  })
})

describe('filterForest', () => {
  test('running keeps matches plus their ancestor chain', () => {
    const forest = buildForest([
      T({ id: 'p' }),
      T({ id: 'idle', parentId: 'p' }),
      T({ id: 'busy', parentId: 'p', status: 'running' }),
      T({ id: 'side', status: 'todo' }),
    ])
    const out = filterForest(forest, 'running')
    const ids: string[] = []
    const walk = (ns: typeof out): void => ns.forEach((x) => (ids.push(x.task.id), walk(x.children)))
    walk(out)
    expect(ids.sort()).toEqual(['busy', 'p'])
  })

  test('due-today matches dueAt inside the local day, boundary-exclusive end', () => {
    const today0 = dayStartOf(Date.now())
    const forest = buildForest([
      T({ id: 'y', dueAt: today0 - 1 }),
      T({ id: 'in', dueAt: today0 + 60_000 }),
      T({ id: 'end', dueAt: today0 + DAY_MS }),
      T({ id: 'none' }),
    ])
    const out = filterForest(forest, 'due-today', today0)
    expect(out.map((r) => r.task.id)).toEqual(['in'])
  })

  test('all drops cancelled cards (archived never clutters the default view)', () => {
    // regression: an early `filter === 'all'` return skipped matches(), so
    // cancelled cards stayed on the board in the default filter
    const forest = buildForest([
      T({ id: 'live', status: 'running' }),
      T({ id: 'dead', status: 'cancelled' }),
      T({ id: 'done', status: 'done' }),
    ])
    const out = filterForest(forest, 'all')
    expect(out.map((r) => r.task.id)).toEqual(['live', 'done'])
  })

  test('a cancelled parent survives nothing: its live children resurface', () => {
    // prune keeps ancestors of matches, never cancelled nodes themselves —
    // a cancelled parent with a live child drops the parent, keeps the child
    const forest = buildForest([
      T({ id: 'cp', status: 'cancelled' }),
      T({ id: 'kid', parentId: 'cp', status: 'todo' }),
    ])
    const out = filterForest(forest, 'all')
    expect(out.map((r) => r.task.id)).toEqual(['kid'])
  })
})

describe('edgePath', () => {
  test('cubic bezier with half-gap control points', () => {
    expect(edgePath(0, 10, 100, 30)).toBe('M 0 10 C 50 10, 50 30, 100 30')
    // narrow gap floors the bend at LAYER_GAP
    expect(edgePath(0, 0, 10, 4)).toBe(`M 0 0 C ${LAYER_GAP} 0, -14 4, 10 4`)
  })
})

describe('timefmt', () => {
  test('dayStartOf zeroes local time', () => {
    const d = new Date(2026, 7, 20, 15, 42, 9, 500)
    expect(dayStartOf(d.getTime())).toBe(new Date(2026, 7, 20).getTime())
  })

  test('fmtClock and fmtStamp same-day vs cross-day', () => {
    const noon = new Date(2026, 7, 20, 9, 5).getTime()
    expect(fmtClock(noon)).toBe('09:05')
    expect(fmtStamp(noon, noon + 3_600_000)).toBe('09:05')
    const other = new Date(2026, 7, 21, 9, 5).getTime()
    expect(fmtStamp(other, noon)).toBe('08-21 09:05')
  })
})
