// packages/web/src/views/ViewSwitcher.tsx — seven-view segmented control
// (指挥中心 / 对话 / 任务板 / 日历 / 活动 / 实时动态 / 驾驶舱) for the sidebar foot.
// The top bar tabs in frame/AppFrame reuse VIEW_META (same icons; labels are
// dictionary keys resolved with t() at render).

import { useT } from '../i18n'
import type { ViewId } from './viewState'

export interface ViewMeta {
  id: ViewId
  /** i18n key (view.*) — resolve with t(labelKey) at render time. */
  labelKey: string
  icon: JSX.Element
}

const COMMAND_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="M5.5 8h4M8 5.5h3.5M5.5 10.5h2" />
  </svg>
)
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
const LIVE_ICON = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
    <path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" />
    <path d="M2.2 2.2a8.2 8.2 0 0 0 0 11.6M13.8 2.2a8.2 8.2 0 0 1 0 11.6" opacity=".45" />
  </svg>
)

export const VIEW_META: ViewMeta[] = [
  { id: 'command', labelKey: 'view.command', icon: COMMAND_ICON },
  { id: 'chat', labelKey: 'view.chat', icon: CHAT_ICON },
  { id: 'board', labelKey: 'view.board', icon: BOARD_ICON },
  { id: 'agenda', labelKey: 'view.agenda', icon: AGENDA_ICON },
  { id: 'activity', labelKey: 'view.activity', icon: ACTIVITY_ICON },
  { id: 'live', labelKey: 'view.live', icon: LIVE_ICON },
  { id: 'cockpit', labelKey: 'view.cockpit', icon: COCKPIT_ICON },
]

export function ViewSwitcher({
  view,
  onChange,
}: {
  view: ViewId
  onChange(view: ViewId): void
}) {
  const { t } = useT()
  return (
    <div className="view-switch" role="group" aria-label={t('frame.tabsAria')}>
      {VIEW_META.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`vsw${view === m.id ? ' active' : ''}`}
          title={t(m.labelKey)}
          aria-pressed={view === m.id}
          onClick={() => onChange(m.id)}
        >
          {m.icon}
          <span>{t(m.labelKey)}</span>
        </button>
      ))}
    </div>
  )
}
