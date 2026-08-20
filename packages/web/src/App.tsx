// packages/web/src/App.tsx — root composition: theme manager + frame store,
// then the three-column AppFrame.

import { AppFrame } from './frame/AppFrame'
import { StoreProvider } from './state/store'
import { useTheme } from './state/theme'

export default function App() {
  const theme = useTheme()
  return (
    <StoreProvider>
      <AppFrame theme={theme} />
    </StoreProvider>
  )
}
