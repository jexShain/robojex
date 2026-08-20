// packages/web/src/main.tsx — React 18 root.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/app.css'
import './styles/effects.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root missing in index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
