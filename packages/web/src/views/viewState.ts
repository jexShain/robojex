// packages/web/src/views/viewState.ts — center-view + frame layout preferences,
// persisted in localStorage like the theme pref. Pure loaders/savers keep
// AppFrame free of storage concerns.

export type ViewId = 'command' | 'chat' | 'board' | 'agenda' | 'activity' | 'cockpit'

const KEY = 'robojex-view'
const SIDEBAR_KEY = 'robojex-sidebar-collapsed'
const DETAILS_KEY = 'robojex-details-open'

const VALID: Record<ViewId, true> = {
  command: true,
  chat: true,
  board: true,
  agenda: true,
  activity: true,
  cockpit: true,
}

export function loadView(): ViewId {
  try {
    // settings › general "start with": a pinned view wins over last-used
    const start = window.localStorage.getItem('robojex-startview')
    if (start === 'command' || start === 'chat') return start
    const raw = window.localStorage.getItem(KEY)
    if (raw === 'thinking') return 'cockpit' // pre-cockpit id migration
    if (raw && raw in VALID) return raw as ViewId
  } catch {
    // storage unavailable (private mode etc.) — default view
  }
  return 'command' // butler default: 指挥中心 (SPEC-BUTLER §7)
}

export function saveView(view: ViewId): void {
  try {
    window.localStorage.setItem(KEY, view)
  } catch {
    // best-effort persistence only
  }
}

/** Boolean frame preference (sidebar collapsed / details open). */
export function loadFlag(key: 'sidebar-collapsed' | 'details-open', fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(
      key === 'sidebar-collapsed' ? SIDEBAR_KEY : DETAILS_KEY,
    )
    if (raw === '1') return true
    if (raw === '0') return false
  } catch {
    // fall through to the default
  }
  return fallback
}

export function saveFlag(key: 'sidebar-collapsed' | 'details-open', value: boolean): void {
  try {
    window.localStorage.setItem(
      key === 'sidebar-collapsed' ? SIDEBAR_KEY : DETAILS_KEY,
      value ? '1' : '0',
    )
  } catch {
    // best-effort persistence only
  }
}
