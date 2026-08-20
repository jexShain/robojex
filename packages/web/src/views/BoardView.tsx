// packages/web/src/views/BoardView.tsx — horizontal task-tree board. Pure
// layout math lives in boardModel.ts; this file owns collapse state, the ghost
// exit pass, the SVG bezier underlay (deepseek gradient, draw-in animation)
// and the filter/expand toolbar. Re-renders are frame-driven: any hello/tasks
// frame swaps state.tasks and CSS transitions tween the card positions.

import { useEffect, useMemo, useRef, useState } from 'react'
import { statusTone, useStore } from '../state/store'
import type { Task } from '../state/types'
import {
  type BoardFilter,
  type PlacedNode,
  buildForest,
  filterForest,
  layoutForest,
  parentIds,
} from './boardModel'
import { fmtStamp } from './timefmt'

const FILTERS: { id: BoardFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'due-today', label: 'Due today' },
]

function Badges({ task, now }: { task: Task; now: number }) {
  return (
    <>
      {task.scheduledAt != null ? (
        <span className="bc-badge sched" title={`scheduled ${fmtStamp(task.scheduledAt, now)}`}>
          ⏱ {fmtStamp(task.scheduledAt, now)}
        </span>
      ) : null}
      {task.dueAt != null ? (
        <span className="bc-badge due" title={`due ${fmtStamp(task.dueAt, now)}`}>
          ⏳ {fmtStamp(task.dueAt, now)}
        </span>
      ) : null}
    </>
  )
}

/** One node card: status dot, title, sched/due badges, caret + child count.
 * The card selects the task (details panel); the caret button toggles. */
function BoardCard({
  placed,
  collapsed,
  now,
  active,
  onSelect,
  onToggle,
}: {
  placed: PlacedNode
  collapsed: boolean
  now: number
  active: boolean
  onSelect(): void
  onToggle(): void
}) {
  const { task, children, subtreeBlocked, subtreeRunning, allChildrenDone } = placed.node
  const tone = statusTone(task.status)
  const hasKids = children.length > 0
  const staggerCls = placed.childIndex > 0 ? `rj-stagger-${Math.min(placed.childIndex, 6)}` : ''
  return (
    <div
      className={[
        'board-card',
        `tone-${tone}`,
        hasKids ? 'has-kids' : '',
        hasKids && collapsed ? 'shut' : '',
        subtreeBlocked && tone !== 'failed' ? 'warn' : '',
        active ? 'active' : '',
        subtreeRunning ? 'subtree-pulse' : '',
        allChildrenDone ? 'subtree-celebrate' : '',
        staggerCls,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ left: placed.x, top: placed.y, animationDelay: `${placed.node.depth * 70}ms` }}
      role="button"
      tabIndex={0}
      aria-label={`${task.title} · ${task.status}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className="bc-dot" />
      <span className="bc-title">{task.title}</span>
      <div className="bc-meta">
        <Badges task={task} now={now} />
        {hasKids ? (
          <button
            type="button"
            className="bc-caret"
            title={collapsed ? `expand ${children.length}` : 'collapse'}
            aria-pressed={!collapsed}
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            <span className="bc-count">{children.length}</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d={collapsed ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4'} />
            </svg>
          </button>
        ) : null}
        {subtreeBlocked && tone !== 'failed' ? (
          <span className="bc-warn" title="a child task is blocked">
            ⚠
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function BoardView() {
  const { state, selectTask } = useStore()
  const [filter, setFilter] = useState<BoardFilter>('all')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  // Aligned clock for badge formatting (hello.now absorbs server skew).
  const now = Date.now() + state.clockOffset

  const forest = useMemo(() => buildForest(state.tasks), [state.tasks])
  const filtered = useMemo(() => filterForest(forest, filter), [forest, filter])
  const layout = useMemo(() => layoutForest(filtered, collapsed), [filtered, collapsed])

  // Ghost exit pass: nodes that vanish (collapse or filter) fade out at their
  // old spot while the survivors tween into place — the "height + opacity"
  // collapse transition, without a layout library.
  const prevRef = useRef<PlacedNode[]>([])
  const [ghosts, setGhosts] = useState<PlacedNode[]>([])
  useEffect(() => {
    const prev = prevRef.current
    const cur = layout.nodes
    const curIds = new Set(cur.map((p) => p.node.task.id))
    const died = prev.filter((p) => !curIds.has(p.node.task.id))
    prevRef.current = cur
    if (died.length === 0) return
    setGhosts((g) => [...g.filter((x) => !curIds.has(x.node.task.id)), ...died])
    const timer = window.setTimeout(() => {
      setGhosts((g) => g.filter((x) => !died.some((d) => d.node.task.id === x.node.task.id)))
    }, 340)
    return () => window.clearTimeout(timer)
  }, [layout])

  const toggle = (id: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (state.tasks.length === 0) {
    return (
      <div className="board-view">
        <div className="board-empty">
          <div className="be-mark">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1.5" y="3" width="5" height="4.4" rx="1.2" />
              <rect x="9" y="1.5" width="5.5" height="4.4" rx="1.2" />
              <path d="M4 7.4v2.5a1.6 1.6 0 0 0 1.6 1.6H9" />
            </svg>
          </div>
          <p>no tasks yet — jex will post its board here</p>
        </div>
      </div>
    )
  }

  const degenerate = layout.nodes.length <= 1
  return (
    <div className="board-view">
      <div className="board-toolbar">
        <div className="seg" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? 'active' : ''}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="board-count" title="visible / total tasks">
          {layout.nodes.length} / {state.tasks.length} tasks
        </span>
        <div className="seg" role="group" aria-label="Expand">
          <button type="button" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button type="button" onClick={() => setCollapsed(new Set(parentIds(filtered)))}>
            Collapse all
          </button>
        </div>
      </div>

      <div className="board-scroller">
        {layout.nodes.length === 0 ? (
          <div className="board-empty">
            <p>no tasks match this filter</p>
          </div>
        ) : (
          <div
            className={`board-canvas${degenerate ? ' degenerate' : ''}`}
            style={{ width: layout.width, height: layout.height }}
          >
            <svg
              className="board-edges"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="board-edge-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stopColor="var(--dsw-static-deepseek-450)" />
                  <stop offset="1" stopColor="var(--dsw-static-deepseek-300)" />
                </linearGradient>
              </defs>
              {layout.edges.map((e) => (
                <g key={e.childId}>
                  <path d={e.d} pathLength={1} />
                  <circle cx={e.x2} cy={e.y2} r={3} fill="var(--dsw-alias-accent-default)" opacity={0.7} />
                </g>
              ))}
            </svg>
            {layout.nodes.map((p) => (
              <BoardCard
                key={p.node.task.id}
                placed={p}
                collapsed={collapsed.has(p.node.task.id)}
                now={now}
                active={p.node.task.id === state.selectedTaskId}
                onSelect={() => selectTask(p.node.task.id)}
                onToggle={() => toggle(p.node.task.id)}
              />
            ))}
            {ghosts.map((g) => (
              <div
                key={`ghost-${g.node.task.id}`}
                className="board-card ghost"
                style={{ left: g.x, top: g.y }}
                aria-hidden="true"
              >
                <span className="bc-dot" />
                <span className="bc-title">{g.node.task.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
