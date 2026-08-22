// packages/web/src/Providers.tsx — shared provider stack so App and WidgetApp
// mount the same language + theme manager + store without duplicating the
// wiring. LangProvider sits above StoreProvider: the store's command echoes
// translate via the snapshot bridge, and every t() consumer renders beneath it.

import type { ReactNode } from 'react'
import { LangProvider } from './i18n'
import { StoreProvider } from './state/store'
import { useTheme } from './state/theme'
import type { ThemeApi } from './state/theme'

/** Language + theme + store wrapper. Children render with a resolved
 * ThemeApi available via useTheme(); the store connects to the core event
 * stream. */
export function Providers({ children }: { children: (theme: ThemeApi) => ReactNode }) {
  const theme = useTheme()
  return (
    <LangProvider>
      <StoreProvider>{children(theme)}</StoreProvider>
    </LangProvider>
  )
}
