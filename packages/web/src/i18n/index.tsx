// packages/web/src/i18n/index.tsx — React binding over the event bridge:
// <LangProvider> keeps {pref, lang} in state (switches apply instantly),
// mirrors the resolved lang onto document.documentElement.dataset.lang for
// [data-lang] CSS, and exposes useT() = { t, lang, pref, setPref }.
// Providers.tsx mounts it above <StoreProvider> so every t() consumer —
// including the store's command echoes — sits underneath it.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { LANG_EVENT, LANG_STORAGE_KEY, readLangPref, resolveLang, translate as translateRaw } from './event'

export type { LangPref, Lang } from './event'
export { fill, langSnapshot, setLangPref, translate } from './event'

export interface TApi {
  /** Translate a flat dot key; missing keys fall back to zh, then the key. */
  t(key: string): string
  /** Resolved language ('system' is never reported here). */
  lang: 'zh' | 'en'
  /** Raw preference, including 'system'. */
  pref: 'zh' | 'en' | 'system'
  setPref(pref: 'zh' | 'en' | 'system'): void
}

const TContext = createContext<TApi | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState(readLangPref)
  const [lang, setLang] = useState(() => resolveLang(readLangPref()))

  /* imperative switches (/lang, palette) ride the bridge back into React */
  useEffect(() => {
    const onEvent = (ev: Event): void => {
      const detail = (ev as CustomEvent<'zh' | 'en' | 'system'>).detail
      if (detail === 'zh' || detail === 'en' || detail === 'system') setPrefState(detail)
    }
    window.addEventListener(LANG_EVENT, onEvent)
    return () => window.removeEventListener(LANG_EVENT, onEvent)
  }, [])

  /* persist + resolve; `system` re-resolves when the OS language changes */
  useEffect(() => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, pref)
    } catch {
      // best-effort
    }
    setLang(resolveLang(pref))
    if (pref !== 'system') return
    const onChange = (): void => setLang(resolveLang('system'))
    window.addEventListener('languagechange', onChange)
    return () => window.removeEventListener('languagechange', onChange)
  }, [pref])

  useEffect(() => {
    document.documentElement.dataset.lang = lang
  }, [lang])

  const setPref = useCallback((next: 'zh' | 'en' | 'system') => setPrefState(next), [])
  const t = useCallback((key: string) => translateRaw(key, lang), [lang])

  return <TContext.Provider value={{ t, lang, pref, setPref }}>{children}</TContext.Provider>
}

export function useT(): TApi {
  const v = useContext(TContext)
  if (!v) throw new Error('useT requires <LangProvider>')
  return v
}
