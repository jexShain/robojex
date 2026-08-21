// packages/web/src/Providers.tsx — shared provider stack so App and WidgetApp
// mount the same theme manager + store without duplicating the wiring.

import type { ReactNode } from 'react'
import { StoreProvider } from './state/store'
import { useTheme } from './state/theme'
import type { ThemeApi } from './state/theme'

/** Theme + store wrapper. Children render with a resolved ThemeApi available
 * via useTheme(); the store connects to the core event stream. */
export function Providers({ children }: { children: (theme: ThemeApi) => ReactNode }) {
  const theme = useTheme()
  return <StoreProvider>{children(theme)}</StoreProvider>
}
