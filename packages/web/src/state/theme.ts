// packages/web/src/state/theme.ts — light/dark/system triple-state theme.
// Preference persists in localStorage; `system` tracks prefers-color-scheme.
// The resolved value toggles body[data-ds-dark-theme], the single hook the
// DSH token sheets read.

import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'robojex-theme'

/** Bridge so non-React code (slash commands) can switch the theme:
 * theme.ts listens for this event and applies the pref globally. */
export const THEME_EVENT = 'robojex:theme'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage unavailable — fall through to dark
  }
  return 'dark'
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref !== 'system') return pref
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export interface ThemeApi {
  pref: ThemePref
  resolved: ResolvedTheme
  setPref(pref: ThemePref): void
}

let currentState: { pref: ThemePref; resolved: ResolvedTheme } = {
  pref: readPref(),
  resolved: resolve(readPref()),
}

export function useTheme(): ThemeApi {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readPref()))

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, pref)
    } catch {
      // persistence is best-effort
    }
    setResolved(resolve(pref))
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setResolved(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [pref])

  useEffect(() => {
    if (resolved === 'dark') document.body.dataset.dsDarkTheme = ''
    else delete document.body.dataset.dsDarkTheme
  }, [resolved])

  // imperative switches (setThemePref from slash commands / settings) bypass
  // React state — listen on the bridge so mounted useTheme() consumers
  // re-render too
  useEffect(() => {
    const onBridge = (ev: Event): void => {
      const detail = (ev as CustomEvent<ThemePref>).detail
      if (detail === 'light' || detail === 'dark' || detail === 'system') setPrefState(detail)
    }
    window.addEventListener(THEME_EVENT, onBridge)
    return () => window.removeEventListener(THEME_EVENT, onBridge)
  }, [])

  const setPref = useCallback((next: ThemePref) => setPrefState(next), [])

  currentState = { pref, resolved }
  return { pref, resolved, setPref }
}

/** Imperative theme switch for slash commands / command palette. */
export function setThemePref(next: ThemePref): void {
  window.dispatchEvent(new CustomEvent<ThemePref>(THEME_EVENT, { detail: next }))
}

/** Live snapshot outside React (e.g. for the /theme command echo). */
export function themeSnapshot(): { pref: ThemePref; resolved: ResolvedTheme } {
  return currentState
}

// Apply theme switches requested via the event bridge (see setThemePref).
window.addEventListener(THEME_EVENT, (ev) => {
  const detail = (ev as CustomEvent<ThemePref>).detail
  if (detail === 'light' || detail === 'dark' || detail === 'system') {
    try {
      localStorage.setItem(STORAGE_KEY, detail)
    } catch {
      // best-effort
    }
    const r = resolve(detail)
    currentState = { pref: detail, resolved: r }
    if (r === 'dark') document.body.dataset.dsDarkTheme = ''
    else delete document.body.dataset.dsDarkTheme
  }
})
