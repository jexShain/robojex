// packages/web/src/views/boardModel.ts — pure board math: task forest, filter
// pruning and the tidy-tree placement (leafs stack top-down, parents center on
// their children, columns advance by depth). Everything is a deterministic
// function of (tasks, collapsed) so the geometry is unit-tested directly.

import type { Task } from '../state/types'
import { DAY_MS, dayStartOf } from './timefmt'

export const CARD_W = 232 // card box: keep in sync with .board-card in app.css
export const CARD_H = 64
/** Horizontal gap between depth layers (spec: 层间距 24px). */
export const LAYER_GAP = 24
/** Vertical gap between same-layer cards (spec: 同层 12px). */
export const ROW_GAP = 12

export type BoardFilter = 'all' | 'running' | 'due-today'

export interface BoardNode {
  task: Task
  children: BoardNode[]
  depth: number
  /** Some task in this subtree (incl. self) is blocked — display-layer
   * warning bubble per the contract (no core-side propagation). */
  subtreeBlocked: boolean
}

export interface PlacedNode {
  node: BoardNode
  x: number
  y: number
}

export interface BoardEdge {
  parentId: string
  childId: string
  d: string
}

export interface BoardLayout {
  nodes: PlacedNode[]
  edges: BoardEdge[]
  width: number
  height: number
}

/** Cubic bezier from a parent's right edge to a child's left edge. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(LAYER_GAP, (x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

/** Nest tasks by parentId into a forest. Orphans (missing/dangling parent)
 * surface as roots so nothing ever disappears; a `seen` guard tolerates
 * parent cycles from stale data. Siblings order by createdAt. */
export function buildForest(tasks: Task[]): BoardNode[] {
  const nodes = new Map<string, BoardNode>()
  for (const t of tasks)
    nodes.set(t.id, { task: t, children: [], depth: 0, subtreeBlocked: false })
  const roots: BoardNode[] = []
  for (const t of tasks) {
    const n = nodes.get(t.id)!
    const p = t.parentId ? nodes.get(t.parentId) : undefined
    if (p) p.children.push(n)
    else roots.push(n)
  }
  const walk = (n: BoardNode, depth: number, seen: Set<string>): void => {
    if (seen.has(n.task.id)) return
    seen.add(n.task.id)
    n.depth = depth
    n.children.sort((a, b) => a.task.createdAt - b.task.createdAt)
    let blocked = n.task.status === 'blocked'
    for (const c of n.children) {
      walk(c, depth + 1, seen)
      blocked = blocked || c.subtreeBlocked
    }
    n.subtreeBlocked = blocked
  }
  const seen = new Set<string>()
  for (const r of roots) walk(r, 0, seen)
  return roots
}

function matches(t: Task, f: BoardFilter, today0: number): boolean {
  if (f === 'all') return true
  if (f === 'running') return t.status === 'running'
  // due-today: dueAt inside today's local day.
  return t.dueAt != null && t.dueAt >= today0 && t.dueAt < today0 + DAY_MS
}

/** Keep the nodes a filter matches plus their ancestor chain, so the tree
 * stays connected instead of floating orphans. */
export function filterForest(
  forest: BoardNode[],
  filter: BoardFilter,
  today0: number = dayStartOf(Date.now()),
): BoardNode[] {
  if (filter === 'all') return forest
  const prune = (n: BoardNode): BoardNode | null => {
    const kids = n.children.map(prune).filter((c): c is BoardNode => c !== null)
    if (!matches(n.task, filter, today0) && kids.length === 0) return null
    return { ...n, children: kids }
  }
  return forest.map(prune).filter((n): n is BoardNode => n !== null)
}

/** Tidy-tree placement of the visible (non-collapsed) forest. `cursorY`
 * stacks leaves; a parent centers between its first and last child's y. */
export function layoutForest(forest: BoardNode[], collapsed: ReadonlySet<string>): BoardLayout {
  const nodes: PlacedNode[] = []
  let cursorY = 0
  let maxDepth = 0

  const place = (n: BoardNode): number => {
    maxDepth = Math.max(maxDepth, n.depth)
    const x = n.depth * (CARD_W + LAYER_GAP)
    let y: number
    if (n.children.length === 0 || collapsed.has(n.task.id)) {
      y = cursorY
      cursorY += CARD_H + ROW_GAP
    } else {
      const childYs = n.children.map(place)
      y = (childYs[0]! + childYs[childYs.length - 1]!) / 2
    }
    nodes.push({ node: n, x, y })
    return y
  }
  for (const r of forest) place(r)

  // DOM order top-to-bottom (tab order + entrance stagger).
  nodes.sort((a, b) => a.y - b.y || a.x - b.x)
  const byId = new Map(nodes.map((p) => [p.node.task.id, p]))
  const edges: BoardEdge[] = []
  for (const p of nodes)
    for (const c of p.node.children) {
      const cp = byId.get(c.task.id)
      if (!cp) continue // hidden by collapse
      edges.push({
        parentId: p.node.task.id,
        childId: c.task.id,
        d: edgePath(p.x + CARD_W, p.y + CARD_H / 2, cp.x, cp.y + CARD_H / 2),
      })
    }

  const width = (maxDepth + 1) * CARD_W + maxDepth * LAYER_GAP
  const height = nodes.length > 0 ? Math.max(...nodes.map((n) => n.y)) + CARD_H : 0
  return { nodes, edges, width, height }
}

/** Ids of every visible node with children — the collapse-all target. */
export function parentIds(forest: BoardNode[]): string[] {
  const out: string[] = []
  const walk = (n: BoardNode): void => {
    if (n.children.length > 0) out.push(n.task.id)
    n.children.forEach(walk)
  }
  forest.forEach(walk)
  return out
}
