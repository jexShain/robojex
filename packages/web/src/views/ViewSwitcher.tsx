// packages/web/src/views/ViewSwitcher.tsx — three-state segmented control
// (Chat / Board / Agenda) for the sidebar foot.

import type { ViewId } from './viewState'

const ICONS: Record<ViewId, JSX.Element> = {
  chat: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 3.5h11v8H8l-3.2 2.6V11.5h-2.3z" />
    </svg>
  ),
  board: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.5" y="3" width="5" height="4.4" rx="1.2" />
      <rect x="9" y="1.5" width="5.5" height="4.4" rx="1.2" />
      <rect x="9" y="8.4" width="5.5" height="4.4" rx="1.2" />
      <path d="M4 7.4v2.5a1.6 1.6 0 0 0 1.6 1.6H9" />
    </svg>
  ),
  agenda: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.8" y="2.6" width="12.4" height="11.4" rx="2" />
      <path d="M1.8 6.2h12.4M5 1.6v2.4M11 1.6v2.4" />
      <path d="M5 9h3.4" />
    </svg>
  ),
}

const LABELS: Record<ViewId, string> = { chat: 'Chat', board: 'Board', agenda: 'Agenda' }

export function ViewSwitcher({
  view,
  onChange,
}: {
  view: ViewId
  onChange(view: ViewId): void
}) {
  return (
    <div className="view-switch" role="group" aria-label="View">
      {(Object.keys(LABELS) as ViewId[]).map((id) => (
        <button
          key={id}
          type="button"
          className={`vsw${view === id ? ' active' : ''}`}
          title={`${LABELS[id]} view`}
          aria-pressed={view === id}
          onClick={() => onChange(id)}
        >
          {ICONS[id]}
          <span>{LABELS[id]}</span>
        </button>
      ))}
    </div>
  )
}
