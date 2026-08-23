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
  /** True when every direct child is 'done' (display-layer celebrate trigger). */
  allChildrenDone: boolean
  /** True when any node in this subtree (incl. self) is 'running'. */
  subtreeRunning: boolean
}

export interface PlacedNode {
  node: BoardNode
  x: number
  y: number
  /** 0-based index among siblings — drives stagger class (rj-stagger-N). */
  childIndex: number
}

export interface BoardEdge {
  parentId: string
  childId: string
  d: string
  /** Child connection point for SVG junction dot. */
  x2: number
  y2: number
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
 * surface as roots so nothing ever disappears. Parent-cycle and
 * self-referencing members are unreachable from any root, so a second sweep
 * promotes every unvisited node to a root (mirroring core nestTasks and the
 * CLI renderer). Siblings order by createdAt. */
export function buildForest(tasks: Task[]): BoardNode[] {
  const nodes = new Map<string, BoardNode>()
  for (const t of tasks)
    nodes.set(t.id, { task: t, children: [], depth: 0, subtreeBlocked: false, allChildrenDone: false, subtreeRunning: false })
  const roots: BoardNode[] = []
  for (const t of tasks) {
    const n = nodes.get(t.id)!
    const p = t.parentId && t.parentId !== t.id ? nodes.get(t.parentId) : undefined
    if (p) p.children.push(n)
    else roots.push(n)
  }
  const walk = (n: BoardNode, depth: number): void => {
    n.depth = depth
    n.children.sort((a, b) => a.task.createdAt - b.task.createdAt)
    let blocked = n.task.status === 'blocked'
    let running = n.task.status === 'running'
    for (const c of n.children) {
      walk(c, depth + 1)
      blocked = blocked || c.subtreeBlocked
      running = running || c.subtreeRunning
    }
    n.subtreeBlocked = blocked
    n.subtreeRunning = running
    n.allChildrenDone = n.children.length > 0 && n.children.every((c) => c.task.status === 'done')
  }
  for (const r of roots) walk(r, 0)
  // orphan sweep: cycle members never got visited from a root — promote them
  // (detached from their nominal parent) so no task silently vanishes
  const reached = new Set<string>()
  const collect = (n: BoardNode): void => {
    if (reached.has(n.task.id)) return
    reached.add(n.task.id)
    n.children.forEach(collect)
  }
  roots.forEach(collect)
  const allNodes = Array.from(nodes.values())
  for (const t of tasks) {
    if (!reached.has(t.id)) {
      const n = nodes.get(t.id)!
      for (const other of allNodes)
        other.children = other.children.filter((c) => c.task.id !== t.id)
      n.children = [] // drop in-cycle children too; they resurface as roots themselves
      roots.push(n)
      walk(n, 0)
    }
  }
  return roots
}

function matches(t: Task, f: BoardFilter, today0: number): boolean {
  // archived cards are retired — they stay in the DB and the chat log, but
  // never clutter the live board
  if (t.status === 'cancelled') return false
  if (f === 'all') return true
  if (f === 'running') return t.status === 'running'
  // due-today: dueAt inside today's local day.
  return t.dueAt != null && t.dueAt >= today0 && t.dueAt < today0 + DAY_MS
}

/** Keep the nodes a filter matches plus their ancestor chain, so the tree
 * stays connected instead of floating orphans. Two distinct retire paths:
 * cancelled cards vanish entirely and their children resurface one level up
 * (archived is history, never a connector), while merely filter-mismatched
 * nodes stay as connectors when a descendant matches. 'all' also runs the
 * prune — an early `filter === 'all'` return used to skip it, so archived
 * cards cluttered the default view. */
export function filterForest(
  forest: BoardNode[],
  filter: BoardFilter,
  today0: number = dayStartOf(Date.now()),
): BoardNode[] {
  const prune = (n: BoardNode): BoardNode[] | null => {
    const kids = n.children.map(prune).filter((c): c is BoardNode[] => c !== null).flat()
    if (n.task.status === 'cancelled') return kids.length > 0 ? kids : null
    if (!matches(n.task, filter, today0) && kids.length === 0) return null
    return [{ ...n, children: kids }]
  }
  const out = forest.map(prune).filter((n): n is BoardNode[] => n !== null).flat()
  // promotion may have shifted levels — restamp depth for the layout pass
  const redepth = (n: BoardNode, d: number): BoardNode => {
    n.depth = d
    n.children = n.children.map((c) => redepth(c, d + 1))
    return n
  }
  return out.map((r) => redepth(r, 0))
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
    nodes.push({ node: n, x, y, childIndex: 0 })
    return y
  }
  for (const r of forest) place(r)

  // DOM order top-to-bottom (tab order + entrance stagger).
  nodes.sort((a, b) => a.y - b.y || a.x - b.x)
  const byId = new Map(nodes.map((p) => [p.node.task.id, p]))

  // Assign childIndex: 0-based index among visible siblings sharing a parent.
  const parentChildMap = new Map<string, PlacedNode[]>()
  for (const p of nodes) {
    const pid = p.node.task.parentId
    if (pid && byId.has(pid)) {
 const arr = parentChildMap.get(pid) ?? []
      arr.push(p)
      parentChildMap.set(pid, arr)
    }
  }
  parentChildMap.forEach((siblings) =>
    siblings.forEach((s, i) => (s.childIndex = i)),
  )

  const edges: BoardEdge[] = []
  for (const p of nodes)
    for (const c of p.node.children) {
      const cp = byId.get(c.task.id)
      if (!cp) continue // hidden by collapse
      edges.push({
        parentId: p.node.task.id,
        childId: c.task.id,
        d: edgePath(p.x + CARD_W, p.y + CARD_H / 2, cp.x, cp.y + CARD_H / 2),
        x2: cp.x,
        y2: cp.y + CARD_H / 2,
      })
    }

  const width = (maxDepth + 1) * CARD_W + maxDepth * LAYER_GAP
  const height = nodes.reduce((max, n) => (n.y > max ? n.y : max), 0) + CARD_H
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
