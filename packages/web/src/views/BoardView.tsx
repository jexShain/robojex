// packages/web/src/views/BoardView.tsx — horizontal task-tree board. Pure
// layout math lives in boardModel.ts; this file owns collapse state, the ghost
// exit pass, the SVG bezier underlay (deepseek gradient, draw-in animation)
// and the filter/expand toolbar. Re-renders are frame-driven: any hello/tasks
// frame swaps state.tasks and CSS transitions tween the card positions.

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { statusTone, useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import { Icon, verdictIcon } from '../ui/Icon'
import { parseQuickTime } from './quickTime'
import { takeBoardFocus } from './boardFocus'
import type { Task } from '../state/types'
import {
  CARD_W,
  type BoardFilter,
  type PlacedNode,
  buildForest,
  filterForest,
  layoutForest,
  parentIds,
} from './boardModel'
import { fmtStamp } from './timefmt'

/** Filter ids map to board.filter.* dictionary keys. */
const FILTERS: BoardFilter[] = ['all', 'running', 'due-today']

/** The picked filter survives reloads — re-picking it every session is the
 *  kind of small tax that makes a daily tool feel forgetful. */
function loadBoardFilter(): BoardFilter {
  const raw = window.localStorage.getItem('robojex-board-filter')
  return FILTERS.includes(raw as BoardFilter) ? (raw as BoardFilter) : 'all'
}

function Badges({ task, now }: { task: Task; now: number }) {
  const { t } = useT()
  return (
    <>
      {task.scheduledAt != null ? (
        <span className="bc-badge sched" title={fill(t('board.schedBadge'), { t: fmtStamp(task.scheduledAt, now) })}>
          <Icon name="clock" size={11} /> {fmtStamp(task.scheduledAt, now)}
        </span>
      ) : null}
      {task.dueAt != null ? (() => {
        // urgency tone: past due burns, under an hour smolders — a glance
        // should carry the time pressure, not just the timestamp
        const delta = task.dueAt! - now
        const urgent = task.status === 'todo' || task.status === 'running' || task.status === 'blocked'
        const cls = !urgent ? '' : delta < 0 ? ' over' : delta < 3_600_000 ? ' soon' : ''
        const key = !urgent ? 'board.dueBadge' : delta < 0 ? 'board.dueOver' : delta < 3_600_000 ? 'board.dueSoon' : 'board.dueBadge'
        return (
          <span className={`bc-badge due${cls}`} title={fill(t(key), { t: fmtStamp(task.dueAt, now) })}>
            <Icon name="clock" size={11} /> {fmtStamp(task.dueAt, now)}
          </span>
        )
      })() : null}
    </>
  )
}

const VERDICTS = new Set(['pass', 'partial', 'fail', 'unchecked'])

/** Card-corner progress ring (20px SVG) + verdict badge. A parent with live
 * children earns the ladder instead of a mystery: the ring arcs to the
 * children's done/total ratio so collapsing a subtree never hides the very
 * progress the collapse hides. Otherwise the ring fills by task.progress.
 * Stroke color follows the verdict semantics: pass→green, partial→amber,
 * fail→red, unchecked→gray. */
function ProgressRing({ task, childDone = 0, childTotal = 0 }: { task: Task; childDone?: number; childTotal?: number }) {
  const { t } = useT()
  const verdict = (task.verdict ?? 'unchecked').toLowerCase()
  const v = VERDICTS.has(verdict) ? verdict : 'unchecked'
  const progress = typeof task.progress === 'number' ? Math.max(0, Math.min(100, task.progress)) : 0
  const showKids = childTotal > 0
  const pct = showKids ? Math.round((childDone / childTotal) * 100) : progress
  const strokeV = showKids ? (pct === 100 ? 'pass' : pct > 0 ? 'partial' : 'unchecked') : v
  const aria = showKids
    ? fill(t('board.childrenProgressAria'), { d: childDone, n: childTotal })
    : fill(t('board.progressAria'), { n: progress })
  return (
    <div className="bc-progress">
      <svg className="ring" viewBox="0 0 36 36" width="20" height="20" aria-label={aria}>
        <circle cx="18" cy="18" r="15.9" className="ring-bg" />
        <circle
          cx="18"
          cy="18"
          r="15.9"
          className={`ring-fg v-${strokeV}`}
          strokeDasharray={`${pct} 100`}
          pathLength={100}
        />
        <text x="18" y="21" textAnchor="middle" className="ring-txt">{pct}</text>
      </svg>
      <span className={`bc-verdict v-${v}`} title={`verdict: ${v}`}>
        <Icon name={verdictIcon(v)} size={11} />
      </span>
    </div>
  )
}

/** Hover detail — the details panel answers clicks, this answers glances.
 * pointer-events: none keeps the card underneath hot: the pop never steals
 * the cursor that spawned it, and leaving the card simply retracts it. */
function TaskPop({ placed, now, canvasW, canvasH }: { placed: PlacedNode; now: number; canvasW: number; canvasH: number }) {
  const { t } = useT()
  const { task, childDone, childTotal } = placed.node
  const POP_W = 264
  const tone = statusTone(task.status)
  // prefer the right of the card, flip inside the canvas when it would clip;
  // vertical clamps keep a deep card's pop reachable without scrolling blind
  const right = placed.x + CARD_W + 12
  const left = right + POP_W <= canvasW ? Math.min(right, canvasW - POP_W) : Math.max(0, placed.x - POP_W - 12)
  const top = Math.max(0, Math.min(placed.y, canvasH - 140))
  const rows: Array<[string, string]> = []
  if (task.scheduledAt != null) rows.push([t('board.pop.sched'), fmtStamp(task.scheduledAt, now)])
  if (task.dueAt != null) rows.push([t('board.pop.due'), fmtStamp(task.dueAt, now)])
  rows.push([t('board.pop.created'), fmtStamp(task.createdAt, now)])
  if (typeof task.progress === 'number') rows.push([t('board.pop.progress'), `${Math.max(0, Math.min(100, task.progress))}%`])
  if (childTotal > 0) rows.push([t('board.pop.children'), `${childDone}/${childTotal}`])
  if (task.assignee) rows.push([t('board.pop.assignee'), task.assignee])
  if (task.verdict) rows.push([t('board.pop.verdict'), task.verdict])
  return (
    <div className={`board-pop tone-${tone}`} style={{ left, top, width: POP_W }} data-testid="board-task-pop">
      <div className="bp-head">
        <span className={`bp-dot tone-${tone}`} />
        <span className="bp-title">{task.title}</span>
      </div>
      <div className="bp-status">
        {task.status}
        {(task.priority ?? 0) > 0 ? <span className="bp-prio">p{task.priority}</span> : null}
      </div>
      {rows.map(([k, v]) => (
        <div className="bp-row" key={k}>
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
      {task.acceptance ? (
        <div className="bp-note" title={task.acceptance}>
          {t('board.pop.acceptance')}: {task.acceptance}
        </div>
      ) : null}
      {task.resultSummary ? (
        <div className="bp-note" title={task.resultSummary}>
          {t('board.pop.result')}: {task.resultSummary}
        </div>
      ) : null}
    </div>
  )
}

/** One node card: status dot, title, sched/due badges, caret + child count,
 * a bottom ladder bar when it has children, drag-to-reorder among siblings
 * and hover-to-pop details. The card selects the task (details panel); the
 * caret button toggles. */
function BoardCard({
  placed,
  collapsed,
  now,
  active,
  dragging,
  dropHalf,
  canDrop,
  onSelect,
  onToggle,
  onRemove,
  onDragStart,
  onDragOverCard,
  onDropCard,
  onDragEnd,
  onHover,
}: {
  placed: PlacedNode
  collapsed: boolean
  now: number
  active: boolean
  dragging: boolean
  dropHalf: 'before' | 'after' | null
  canDrop: boolean
  onSelect(): void
  onToggle(): void
  onRemove(): void
  onDragStart(e: DragEvent<HTMLDivElement>): void
  onDragOverCard(e: DragEvent<HTMLDivElement>): void
  onDropCard(): void
  onDragEnd(): void
  onHover(id: string | null): void
}) {
  const { t } = useT()
  // two-step cancel: cancelled is terminal (no un-cancel API), and a hover
  // trash is one misclick away from it — first click arms the button for
  // 2.5s (solid red check), second click fires, timeout stands down
  const [armed, setArmed] = useState(false)
  const armTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(armTimer.current), [])
  const { task, children, childDone, childTotal, subtreeBlocked, subtreeRunning, allChildrenDone } = placed.node
  const tone = statusTone(task.status)
  const hasKids = children.length > 0
  const kidsPct = childTotal > 0 ? Math.round((childDone / childTotal) * 100) : 0
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
        dragging ? 'dragging' : '',
        dropHalf === 'before' ? 'drop-before' : dropHalf === 'after' ? 'drop-after' : '',
        canDrop && !dragging ? 'droppable' : '',
        staggerCls,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ left: placed.x, top: placed.y, animationDelay: `${placed.node.depth * 70}ms` }}
      role="button"
      tabIndex={0}
      aria-label={`${task.title} · ${task.status}`}
      draggable
      onClick={onSelect}
      onDragStart={onDragStart}
      onDragOver={onDragOverCard}
      onDrop={(e) => {
        e.preventDefault()
        onDropCard()
      }}
      onDragEnd={onDragEnd}
      onMouseEnter={() => onHover(task.id)}
      onMouseLeave={() => onHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className="bc-dot" />
      <span className="bc-title">{task.title}</span>
      {typeof task.progress === 'number' || task.verdict || childTotal > 0 ? (
        <ProgressRing task={task} childDone={childDone} childTotal={childTotal} />
      ) : null}
      <div className="bc-meta">
        <Badges task={task} now={now} />
        {task.status !== 'done' && task.status !== 'cancelled' ? (
          <button
            type="button"
            className={`bc-cancel${armed ? ' armed' : ''}`}
            title={armed ? t('board.confirmCancel') : t('board.cancelTask')}
            aria-label={armed ? t('board.confirmCancel') : fill(t('board.cancelTask'), { t: task.title })}
            aria-pressed={armed}
            onClick={(e) => {
              e.stopPropagation()
              if (!armed) {
                setArmed(true)
                window.clearTimeout(armTimer.current)
                armTimer.current = window.setTimeout(() => setArmed(false), 2_500)
                return
              }
              window.clearTimeout(armTimer.current)
              onRemove()
            }}
          >
            <Icon name={armed ? 'check' : 'trash'} size={11} />
          </button>
        ) : null}
        {hasKids ? (
          <button
            type="button"
            className="bc-caret"
            title={collapsed ? fill(t('board.expandN'), { n: children.length }) : t('board.collapse')}
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
          <span className="bc-warn" title={t('board.childBlocked')}>
            <Icon name="ban" size={11} />
          </span>
        ) : null}
      </div>
      {hasKids ? (
        <span
          className={`bc-kids${kidsPct === 100 ? ' full' : ''}`}
          style={{ ['--fill' as string]: `${kidsPct}%` }}
          title={fill(t('board.childrenProgressAria'), { d: childDone, n: childTotal })}
          aria-hidden="true"
        />
      ) : null}
    </div>
  )
}

export function BoardView() {
  const { state, selectTask } = useStore()
  const { t } = useT()
  const [filter, setFilter] = useState<BoardFilter>(loadBoardFilter)
  useEffect(() => {
    window.localStorage.setItem('robojex-board-filter', filter)
  }, [filter])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // + new-task inline entry (POST /api/task; the tasks broadcast updates the
  // store, so no local list patching is needed)
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  // CmdK "new task" handoff: focus the create input (on mount after a view
  // switch, or live when already on board)
  const newInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => takeBoardFocus(() => newInputRef.current?.focus()), [])

  const createTask = async (): Promise<void> => {
    const raw = newTitle.trim()
    if (!raw || creating) return
    setCreating(true)
    setCreateErr(null)
    try {
      // quick time syntax: 「明天9点 检查磁盘 截止11点」 carries its slot
      const quick = parseQuickTime(raw)
      const title = quick?.title ?? raw
      const res = await fetch('/api/task', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          ...(quick?.scheduledAt !== undefined ? { scheduledAt: quick.scheduledAt } : {}),
          ...(quick?.dueAt !== undefined ? { dueAt: quick.dueAt } : {}),
        }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      setNewTitle('')
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  // Operator cancel (PUT /api/task): the tasks broadcast updates the store,
  // and the board filter drops cancelled cards — no local patching needed.
  const removeTask = async (id: string): Promise<void> => {
    try {
      const res = await fetch('/api/task', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, status: 'cancelled' }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : String(err))
    }
  }

  // Aligned clock for badge formatting (hello.now absorbs server skew).
  const now = Date.now() + state.clockOffset

  const forest = useMemo(() => buildForest(state.tasks), [state.tasks])
  const filtered = useMemo(() => filterForest(forest, filter), [forest, filter])
  const layout = useMemo(() => layoutForest(filtered, collapsed), [filtered, collapsed])
  const placedById = useMemo(
    () => new Map(layout.nodes.map((p) => [p.node.task.id, p])),
    [layout],
  )

  // drag-drop priority: the drop slot is half-of-target (above the fold =
  // before, below = after); POST /api/task/reorder rewrites the ladder in one
  // shot and its tasks broadcast drives the left/top tween — no optimistic
  // patch, the board order is exactly what the server persisted. Reordering
  // is sibling-local: cross-parent drops are refused, reparenting stays an
  // explicit act (the loop's job), not a drag accident.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; half: 'before' | 'after' } | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const groupOf = (id: string): string => placedById.get(id)?.node.task.parentId ?? ''
  const groupSize = (gid: string): number =>
    layout.nodes.reduce((n, p) => (p.node.task.parentId ?? '') === gid ? n + 1 : n, 0)

  const startDrag = (e: DragEvent<HTMLDivElement>, id: string): void => {
    setDragId(id)
    setHoverId(null) // the pop follows the cursor out — dragging is the intent
    e.dataTransfer.setData('text/plain', id)
    e.dataTransfer.effectAllowed = 'move'
  }
  const overCard = (e: DragEvent<HTMLDivElement>, id: string): void => {
    if (!dragId || dragId === id || groupOf(dragId) !== groupOf(id)) return
    if (groupSize(groupOf(id)) < 2) return
    e.preventDefault() // only same-group siblings accept the drop cursor
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    const half: 'before' | 'after' = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
    setDropTarget((d) => (d && d.id === id && d.half === half ? d : { id, half }))
  }
  const endDrag = (): void => {
    setDragId(null)
    setDropTarget(null)
  }
  const commitDrop = async (): Promise<void> => {
    const target = dropTarget
    if (!dragId || !target || target.id === dragId) return endDrag()
    const gid = groupOf(dragId)
    const ids = layout.nodes
      .filter((p) => (p.node.task.parentId ?? '') === gid)
      .map((p) => p.node.task.id) // DOM order = top-to-bottom = current ladder
    if (!ids.includes(dragId) || !ids.includes(target.id)) return endDrag()
    const next = ids.filter((x) => x !== dragId)
    // slot in the ladder WITHOUT the dragged card — anchoring on ids[] would
    // be off by one whenever the drag came from above the target
    const idx = next.indexOf(target.id)
    next.splice(target.half === 'after' ? idx + 1 : idx, 0, dragId)
    if (next.join('|') === ids.join('|')) return endDrag()
    endDrag()
    try {
      const res = await fetch('/api/task/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: next }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(d.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : String(err))
    }
  }

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

  const emptyBoard = state.tasks.length === 0

  const toolbar = (
    <div className="board-toolbar">
      <div className="board-new" data-testid="board-new-task">
        <input
          ref={newInputRef}
          className="bn-input"
          value={newTitle}
          placeholder={t('board.newPlaceholder')}
          disabled={creating}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createTask()
          }}
        />
        <button
          type="button"
          className="bn-btn"
          title={t('board.create')}
          disabled={!newTitle.trim() || creating}
          onClick={() => void createTask()}
        >
          {creating ? '…' : <Icon name="plus" size={13} />}
        </button>
      </div>
      {createErr ? (
        <span className="bn-err" title={createErr}>
          <Icon name="x" size={11} /> {createErr}
        </span>
      ) : null}
      <div className="seg" role="group" aria-label={t('board.filterAria')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? 'active' : ''}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`board.filter.${f}`)}
            </button>
          ))}
        </div>
        <span className="board-count" title={t('board.countTitle')}>
          {fill(t('board.count'), { n: layout.nodes.length, m: state.tasks.length })}
        </span>
        <div className="seg" role="group" aria-label={t('board.expandAria')}>
          <button type="button" onClick={() => setCollapsed(new Set())}>
            {t('board.expandAll')}
          </button>
          <button type="button" onClick={() => setCollapsed(new Set(parentIds(filtered)))}>
            {t('board.collapseAll')}
          </button>
        </div>
      </div>
  )

  const degenerate = layout.nodes.length <= 1
  return (
    <div className="board-view">
      {toolbar}
      {emptyBoard ? (
        <div className="board-empty">
          <div className="be-mark">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="1.5" y="3" width="5" height="4.4" rx="1.2" />
              <rect x="9" y="1.5" width="5.5" height="4.4" rx="1.2" />
              <path d="M4 7.4v2.5a1.6 1.6 0 0 0 1.6 1.6H9" />
            </svg>
          </div>
          <p>{t('board.empty')}</p>
        </div>
      ) : (
      <div className="board-scroller">
        {layout.nodes.length === 0 ? (
          <div className="board-empty">
            <p>{t('board.filterEmpty')}</p>
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
                dragging={p.node.task.id === dragId}
                dropHalf={dropTarget && dropTarget.id === p.node.task.id ? dropTarget.half : null}
                canDrop={
                  dragId != null &&
                  dragId !== p.node.task.id &&
                  groupOf(dragId) === groupOf(p.node.task.id)
                }
                onSelect={() => selectTask(p.node.task.id)}
                onToggle={() => toggle(p.node.task.id)}
                onRemove={() => void removeTask(p.node.task.id)}
                onDragStart={(e) => startDrag(e, p.node.task.id)}
                onDragOverCard={(e) => overCard(e, p.node.task.id)}
                onDropCard={() => void commitDrop()}
                onDragEnd={endDrag}
                onHover={(id) => setHoverId((h) => (id === null ? (h === p.node.task.id ? null : h) : id))}
              />
            ))}
            {hoverId && !dragId && placedById.has(hoverId) ? (
              <TaskPop
                placed={placedById.get(hoverId)!}
                now={now}
                canvasW={layout.width}
                canvasH={layout.height}
              />
            ) : null}
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
      )}
    </div>
  )
}
