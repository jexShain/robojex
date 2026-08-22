// packages/web/src/i18n/event.ts — language preference storage + the event
// bridge for non-React code (slash commands, the store). Pattern mirrors
// state/theme.ts: preference persists in localStorage, `system` tracks
// navigator.language (zh* → zh, else en), and switches ride a DOM CustomEvent
// so <LangProvider> and imperative callers stay in lock-step. Node-safe:
// every browser global is guarded so vitest can import the store freely.

import { zh } from './zh'
import { en } from './en'

export type LangPref = 'zh' | 'en' | 'system'
export type Lang = 'zh' | 'en'

/** Bridge event: setLangPref dispatches, the listener below applies. */
export const LANG_EVENT = 'robojex:lang'

export const LANG_STORAGE_KEY = 'robojex-lang'

const DICTS: Record<Lang, Record<string, string>> = { zh, en }

export function readLangPref(): LangPref {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY)
    if (v === 'zh' || v === 'en' || v === 'system') return v
  } catch {
    // storage unavailable — fall through to system
  }
  return 'system'
}

/** Resolve a preference to a concrete language; `system` follows the OS. */
export function resolveLang(pref: LangPref): Lang {
  if (pref !== 'system') return pref
  const nav = typeof navigator === 'undefined' ? '' : navigator.language
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export interface LangState {
  pref: LangPref
  lang: Lang
}

let currentState: LangState = { pref: readLangPref(), lang: resolveLang(readLangPref()) }

/** Live snapshot outside React (slash-command echoes, the store, Markdown). */
export function langSnapshot(): LangState {
  return currentState
}

function applyPref(pref: LangPref): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, pref)
  } catch {
    // persistence is best-effort
  }
  currentState = { pref, lang: resolveLang(pref) }
  if (typeof document !== 'undefined') document.documentElement.dataset.lang = currentState.lang
}

/** Imperative language switch for slash commands / the command palette. */
export function setLangPref(next: LangPref): void {
  if (typeof window === 'undefined') {
    applyPref(next) // tests / SSR: apply directly, no event loop
    return
  }
  window.dispatchEvent(new CustomEvent<LangPref>(LANG_EVENT, { detail: next }))
}

/** Non-React translate: current snapshot lang (or an explicit one), zh
 * fallback, the key itself last so a missing entry never blanks the UI. */
export function translate(key: string, lang?: Lang): string {
  const l = lang ?? currentState.lang
  const v = DICTS[l][key] ?? zh[key]
  if (v === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`)
    return key
  }
  return v
}

/** Tiny {placeholder} interpolation shared by every caller of t(). */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

// Paint dataset.lang from the start (the provider keeps it in sync afterwards).
if (typeof document !== 'undefined') {
  document.documentElement.dataset.lang = currentState.lang
}

// Apply language switches requested via the event bridge (see setLangPref).
if (typeof window !== 'undefined') {
  window.addEventListener(LANG_EVENT, (ev) => {
    const detail = (ev as CustomEvent<LangPref>).detail
    if (detail === 'zh' || detail === 'en' || detail === 'system') applyPref(detail)
  })
}
