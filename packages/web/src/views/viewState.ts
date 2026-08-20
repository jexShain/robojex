// packages/web/src/views/viewState.ts — center-view preference (Chat / Board /
// Agenda), persisted in localStorage like the theme pref. Pure loaders/savers
// keep AppFrame free of storage concerns.

export type ViewId = 'chat' | 'board' | 'agenda' | 'thinking'

const KEY = 'robojex-view'

const VALID: Record<ViewId, true> = { chat: true, board: true, agenda: true, thinking: true }

export function loadView(): ViewId {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw && raw in VALID) return raw as ViewId
  } catch {
    // storage unavailable (private mode etc.) — default view
  }
  return 'chat'
}

export function saveView(view: ViewId): void {
  try {
    window.localStorage.setItem(KEY, view)
  } catch {
    // best-effort persistence only
  }
}
