// packages/web/src/main.tsx — React 18 root.
// /widget path renders the desktop-widget mini console; everything else
// renders the full three-column console App.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactElement } from 'react'
import App from './App'
import { WidgetAppRoot } from './widget/WidgetApp'
import './styles/tokens.css'
import './styles/app.css'
import './styles/hud.css'
import './styles/effects.css'
import './widget/widget.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing in index.html')

const target: ReactElement =
  location.pathname === '/widget' ? <WidgetAppRoot /> : <App />

createRoot(container).render(<StrictMode>{target}</StrictMode>)
