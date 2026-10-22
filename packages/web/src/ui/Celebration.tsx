// packages/web/src/ui/Celebration.tsx — task-completion confetti (T6).
// Zero-canvas, zero-dependency particles: divs driven by CSS custom
// properties (--tx/--ty/--rot/--hue/--d) and the keyframes in effects.css.
// `celebrate()` is a DOM-event bridge (robojex:celebrate) so store code,
// slash commands, and future plugins can all fire it without prop drilling.
// CelebrationWatcher (inside the store tree) turns real task status → done
// transitions into bursts anchored on the task's card when one is visible.

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { statusTone, useStore } from '../state/store'

export const CELEBRATE_EVENT = 'robojex:celebrate'

export interface CelebrateDetail {
  /** burst origin; defaults to viewport centre-upper */
  x?: number
  y?: number
  /** optional label shown at the origin for a beat */
  title?: string
}

export function celebrate(detail: CelebrateDetail = {}): void {
  window.dispatchEvent(new CustomEvent<CelebrateDetail>(CELEBRATE_EVENT, { detail }))
}

interface Particle {
  id: number
  tx: number
  ty: number
  rot: number
  hue: number
  delay: number
  kind: 'bit' | 'spark'
}

interface Burst {
  id: number
  x: number
  y: number
  title: string
  parts: Particle[]
}

// hues ride the brand palette (violet/blue/cyan) + celebration accents
const HUES = [212, 258, 174, 96, 38, 350]
const BITS = 26
const SPARKS = 14
const BURST_MS = 1700

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function makeParts(seed: number): Particle[] {
  const parts: Particle[] = []
  for (let i = 0; i < BITS; i++) {
    const angle = rand(0, Math.PI * 2)
    const dist = rand(70, 260)
    parts.push({
      id: seed + i,
      kind: 'bit',
      tx: Math.cos(angle) * dist,
      ty: Math.sin(angle) * dist * 0.5 - rand(30, 120), // pop upward first; gravity pulls it down in the keyframe
      rot: rand(-540, 540),
      hue: HUES[i % HUES.length],
      delay: rand(0, 120),
    })
  }
  for (let i = 0; i < SPARKS; i++) {
    const angle = (i / SPARKS) * Math.PI * 2 + rand(-0.15, 0.15)
    const dist = rand(50, 160)
    parts.push({
      id: seed + BITS + i,
      kind: 'spark',
      tx: Math.cos(angle) * dist,
      ty: Math.sin(angle) * dist,
      rot: 0,
      hue: HUES[i % HUES.length],
      delay: rand(0, 60),
    })
  }
  return parts
}

/** dumb listener layer — mount at body level, no store needed */
export function CelebrationLayer() {
  const [bursts, setBursts] = useState<Burst[]>([])

  useEffect(() => {
    const onCelebrate = (ev: Event): void => {
      const d = (ev as CustomEvent<CelebrateDetail>).detail ?? {}
      const x = typeof d.x === 'number' ? d.x : window.innerWidth / 2
      const y = typeof d.y === 'number' ? d.y : window.innerHeight * 0.4
      const seed = Date.now() % 1_000_000
      const burst: Burst = { id: seed, x, y, title: d.title ?? '', parts: makeParts(seed) }
      setBursts((prev) => [...prev, burst])
      window.setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== seed)), BURST_MS)
    }
    window.addEventListener(CELEBRATE_EVENT, onCelebrate)
    return () => window.removeEventListener(CELEBRATE_EVENT, onCelebrate)
  }, [])

  return (
    <div className="rj-celebration" aria-hidden="true">
      {bursts.map((b) => (
        <div key={b.id} className="rj-burst" style={{ left: b.x, top: b.y }}>
          <span className="rj-burst-ring" />
          {b.title ? <span className="rj-burst-title">{b.title}</span> : null}
          {b.parts.map((p) => (
            <span
              key={p.id}
              className={`rj-particle rj-p-${p.kind}`}
              style={
                {
                  '--tx': `${Math.round(p.tx)}px`,
                  '--ty': `${Math.round(p.ty)}px`,
                  '--rot': `${Math.round(p.rot)}deg`,
                  '--hue': p.hue,
                  '--d': `${Math.round(p.delay)}ms`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** smart consumer — mounts inside Providers; celebrates when a task
 *  transitions into a done status (hydration-seeded, so first paint never
 *  blasts a burst per pre-existing done task) */
export function CelebrationWatcher(): ReactNode {
  const { state } = useStore()
  const prev = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    const next = new Map(state.tasks.map((t) => [t.id, t.status]))
    const before = prev.current
    if (before) {
      for (const [id, status] of next) {
        const was = before.get(id)
        if (was === undefined || was === status) continue
        if (statusTone(status) !== 'done') continue
        const el = document.querySelector<HTMLElement>(
          `[data-task-id="${CSS.escape(id)}"], [data-testid="task-${CSS.escape(id)}"]`,
        )
        const r = el?.getBoundingClientRect()
        celebrate({
          x: r && r.width > 0 ? Math.round(r.left + r.width / 2) : undefined,
          y: r && r.height > 0 ? Math.round(r.top + r.height / 2) : undefined,
        })
        if (el) {
          // retriggerable celebration pop on the card itself
          el.classList.remove('rj-celebrate')
          void el.offsetWidth
          el.classList.add('rj-celebrate')
          window.setTimeout(() => el.classList.remove('rj-celebrate'), 900)
        }
      }
    }
    prev.current = next
  }, [state.tasks])

  return null
}
