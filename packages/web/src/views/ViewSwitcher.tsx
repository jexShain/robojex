// packages/web/src/views/ViewSwitcher.tsx — five-view segmented control
// (对话 / 任务板 / 日历 / 活动 / 驾驶舱) for the sidebar foot. The top bar
// tabs in frame/AppFrame reuse VIEW_META (same icons + labels).

import type { ViewId } from './viewState'

export interface ViewMeta {
  id: ViewId
  label: string
  icon: JSX.Element
}

const CHAT_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2.5 3.5h11v8H8l-3.2 2.6V11.5h-2.3z" />
  </svg>
)
const BOARD_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1.5" y="3" width="5" height="4.4" rx="1.2" />
    <rect x="9" y="1.5" width="5.5" height="4.4" rx="1.2" />
    <rect x="9" y="8.4" width="5.5" height="4.4" rx="1.2" />
    <path d="M4 7.4v2.5a1.6 1.6 0 0 0 1.6 1.6H9" />
  </svg>
)
const AGENDA_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1.8" y="2.6" width="12.4" height="11.4" rx="2" />
    <path d="M1.8 6.2h12.4M5 1.6v2.4M11 1.6v2.4" />
    <path d="M5 9h3.4" />
  </svg>
)
const ACTIVITY_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />
  </svg>
)
const COCKPIT_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2.5 12a5.5 5.5 0 0 1 11 0" />
    <path d="M8 12l2.6-3.4" />
    <circle cx="8" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
)

export const VIEW_META: ViewMeta[] = [
  { id: 'chat', label: '对话', icon: CHAT_ICON },
  { id: 'board', label: '任务板', icon: BOARD_ICON },
  { id: 'agenda', label: '日历', icon: AGENDA_ICON },
  { id: 'activity', label: '活动', icon: ACTIVITY_ICON },
  { id: 'cockpit', label: '驾驶舱', icon: COCKPIT_ICON },
]

export function ViewSwitcher({
  view,
  onChange,
}: {
  view: ViewId
  onChange(view: ViewId): void
}) {
  return (
    <div className="view-switch" role="group" aria-label="View">
      {VIEW_META.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`vsw${view === m.id ? ' active' : ''}`}
          title={`${m.label} view`}
          aria-pressed={view === m.id}
          onClick={() => onChange(m.id)}
        >
          {m.icon}
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  )
}
