// packages/web/src/App.tsx — root composition: theme manager + frame store,
// then the three-column AppFrame.

import { AppFrame } from './frame/AppFrame'
import { Providers } from './Providers'

export default function App() {
  return (
    <Providers>
      {(theme) => <AppFrame theme={theme} />}
    </Providers>
  )
}
