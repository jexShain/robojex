// packages/web/src/sidebar/Sidebar.tsx — task board, budget footer, mode chip,
// theme triple-cube switcher. DSH visual clone on the token vocabulary.

import { statusTone, useStore } from '../state/store'
import type { ThemeApi, ThemePref } from '../state/theme'
import type { Task } from '../state/types'
import { ViewSwitcher } from '../views/ViewSwitcher'
import type { ViewId } from '../views/viewState'

const MODE_LABEL: Record<string, string> = {
  observe: 'observe',
  assist: 'assist',
  full: 'full',
}

function TaskItem({ task, active, onSelect }: { task: Task; active: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      className={`task-item${active ? ' active' : ''}`}
      onClick={onSelect}
      title={`${task.title} · ${task.status}`}
    >
      <span className={`dot ${statusTone(task.status)}`} />
      <span className="t">{task.title}</span>
    </button>
  )
}

function ThemeCubes({ theme }: { theme: ThemeApi }) {
  const cubes: { pref: ThemePref; title: string; icon: JSX.Element }[] = [
    {
      pref: 'light',
      title: 'Light theme',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="3.2" />
          <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
        </svg>
      ),
    },
    {
      pref: 'dark',
      title: 'Dark theme',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8a5.6 5.6 0 1 0 7.1 7.1Z" />
        </svg>
      ),
    },
    {
      pref: 'system',
      title: 'Follow system theme',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
          <path d="M5.5 13.5h5" />
        </svg>
      ),
    },
  ]
  return (
    <div className="theme-cubes" role="group" aria-label="Theme">
      {cubes.map((c) => (
        <button
          key={c.pref}
          type="button"
          className={`cube${theme.pref === c.pref ? ' active' : ''}`}
          title={c.title}
          aria-label={c.title}
          aria-pressed={theme.pref === c.pref}
          onClick={() => theme.setPref(c.pref)}
        >
          {c.icon}
        </button>
      ))}
    </div>
  )
}

export function Sidebar({
  theme,
  overlay = false,
  onCollapse,
  view,
  onView,
}: {
  theme: ThemeApi
  overlay?: boolean
  onCollapse(): void
  view: ViewId
  onView(view: ViewId): void
}) {
  const { state, selectTask } = useStore()
  const budget = state.budget
  const pct =
    budget && budget.dailyTokens > 0
      ? Math.min(100, Math.round((budget.spentToday / budget.dailyTokens) * 100))
      : 0

  return (
    <aside className={`sidebar${overlay ? ' overlay' : ''}`}>
      <div className="sidebar-head">
        <div className="logo">j</div>
        <span className="sidebar-title">jex</span>
        <span className={`conn-dot ${state.conn}`} title={`connection: ${state.conn}`} />
        <button
          type="button"
          className="icon-btn"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          onClick={onCollapse}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <line x1="6" y1="2.5" x2="6" y2="13.5" />
            <path d="M11 6.5 9 8l2 1.5" />
          </svg>
        </button>
      </div>

      <div className="task-list">
        <div className="task-group">Tasks · {state.tasks.length}</div>
        {state.tasks.length === 0 ? (
          <div className="task-empty">no tasks yet — jex will post its board here</div>
        ) : (
          state.tasks.map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              active={t.id === state.selectedTaskId}
              onSelect={() => selectTask(t.id === state.selectedTaskId ? null : t.id)}
            />
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <ViewSwitcher view={view} onChange={onView} />
        <div className="budget-row" title={budget?.line ?? 'budget unknown'}>
          <span>{budget ? budget.line : 'budget unknown'}</span>
          {budget && budget.dailyTokens > 0 ? (
            <div className="budget-bar">
              <div style={{ width: `${pct}%` }} />
            </div>
          ) : null}
        </div>
        <div className="foot-line">
          <span className={`chip ${state.mode}`}>
            <span className="cdot" />
            {MODE_LABEL[state.mode] ?? state.mode}
          </span>
          <ThemeCubes theme={theme} />
        </div>
      </div>
    </aside>
  )
}
