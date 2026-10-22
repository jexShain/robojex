// packages/web/src/App.tsx — root composition: theme manager + frame store,
// then the three-column AppFrame. T6 mounts the celebration watcher (listens
// to task status → done inside the store) and the first-boot skeleton veil.

import { AppFrame } from './frame/AppFrame'
import { Providers } from './Providers'
import { CelebrationWatcher } from './ui/Celebration'
import { LoadingVeil } from './ui/Skeleton'

export default function App() {
  return (
    <Providers>
      {(theme) => (
        <>
          <CelebrationWatcher />
          <LoadingVeil />
          <AppFrame theme={theme} />
        </>
      )}
    </Providers>
  )
}
