// packages/web/src/main.tsx — React 18 root.
// /widget path renders the desktop-widget mini console; everything else
// renders the full three-column console App.
// T6 motion system: boot splash + celebration particles mount as separate
// body-level roots above the App so they never re-render with the store.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactElement } from 'react'
import App from './App'
import { WidgetAppRoot } from './widget/WidgetApp'
import { BootSplash } from './ui/BootSplash'
import { CelebrationLayer } from './ui/Celebration'
import './styles/tokens.css'
import './styles/app.css'
import './styles/hud.css'
import './styles/effects.css'
import './widget/widget.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing in index.html')

const isWidget = location.pathname === '/widget'
const target: ReactElement = isWidget ? <WidgetAppRoot /> : <App />

createRoot(container).render(<StrictMode>{target}</StrictMode>)

if (!isWidget) {
  const overlays: Array<[string, ReactElement]> = [
    ['rj-boot-root', <BootSplash />],
    ['rj-celebrate-root', <CelebrationLayer />],
  ]
  for (const [id, el] of overlays) {
    const holder = document.createElement('div')
    holder.id = id
    document.body.appendChild(holder)
    createRoot(holder).render(el)
  }
}
