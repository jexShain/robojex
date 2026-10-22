// packages/web/src/ui/BootSplash.tsx — pure-CSS boot overlay (T6 motion system).
// A lottie-like entrance without the lottie runtime: SVG stroke-draw ring,
// orbiting dots, gradient wordmark shimmer, indeterminate progress bar.
// Mounted by main.tsx as its own root so it never blocks the app tree;
// dismisses itself once the window has loaded (min dwell + hard cap so a
// slow bundle can never leave it up forever). prefers-reduced-motion → gone.

import { useEffect, useState } from 'react'

const MIN_DWELL_MS = 750
const HARD_CAP_MS = 3000
const OUT_MS = 600

type Phase = 'in' | 'out' | 'gone'

export function BootSplash() {
  const [phase, setPhase] = useState<Phase>('in')

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('gone')
      return
    }
    const t0 = performance.now()
    let armTimer = 0
    const armOut = (): void => {
      const wait = Math.max(0, MIN_DWELL_MS - (performance.now() - t0))
      armTimer = window.setTimeout(() => setPhase((p) => (p === 'in' ? 'out' : p)), wait)
    }
    if (document.readyState === 'complete') armOut()
    else window.addEventListener('load', armOut, { once: true })
    const cap = window.setTimeout(() => setPhase((p) => (p === 'in' ? 'out' : p)), HARD_CAP_MS)
    return () => {
      window.removeEventListener('load', armOut)
      window.clearTimeout(armTimer)
      window.clearTimeout(cap)
    }
  }, [])

  useEffect(() => {
    if (phase !== 'out') return
    const t = window.setTimeout(() => setPhase('gone'), OUT_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  if (phase === 'gone') return null
  return (
    <div className={`rj-boot${phase === 'out' ? ' rj-boot-out' : ''}`} aria-hidden="true">
      <div className="rj-boot-stage">
        <div className="rj-boot-mark">
          <div className="rj-boot-orbit">
            <span />
            <span />
            <span />
          </div>
          <svg className="rj-boot-gear" viewBox="0 0 120 120" width="110" height="110">
            <defs>
              <linearGradient id="rj-boot-grad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--rj-brand-violet, #8b5cf6)" />
                <stop offset="0.55" stopColor="var(--rj-brand-cyan, #679efe)" />
                <stop offset="1" stopColor="var(--rj-brand-cyan, #22d3ee)" />
              </linearGradient>
            </defs>
            <circle className="rj-boot-ring" cx="60" cy="60" r="46" stroke="url(#rj-boot-grad)" />
            <circle className="rj-boot-dash" cx="60" cy="60" r="34" stroke="url(#rj-boot-grad)" />
            <rect className="rj-boot-core" x="52" y="52" width="16" height="16" rx="4" />
          </svg>
        </div>
        <div className="rj-boot-word">
          jex console<span className="rj-boot-caret">_</span>
        </div>
        <div className="rj-boot-bar">
          <i />
        </div>
      </div>
    </div>
  )
}
