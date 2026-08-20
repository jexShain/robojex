// packages/web/src/state/theme.ts — light/dark/system triple-state theme.
// Preference persists in localStorage; `system` tracks prefers-color-scheme.
// The resolved value toggles body[data-ds-dark-theme], the single hook the
// DSH token sheets read.

import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'robojex-theme'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage unavailable — fall through to system
  }
  return 'system'
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

  const setPref = useCallback((next: ThemePref) => setPrefState(next), [])

  return { pref, resolved, setPref }
}
