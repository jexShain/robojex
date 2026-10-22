// packages/web/src/ui/Reveal.tsx — scroll reveal + parallax (T6).
// Parallax is pure CSS scroll-driven animation (animation-timeline: view())
// where the browser supports it; everywhere else useParallax falls back to a
// rAF-throttled scroll handler writing the same transform. Reveal rides an
// IntersectionObserver toggling .revealed — entrance choreography without a
// library, reduced-motion-safe via effects.css.

import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'

export const supportsViewTimeline =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  (CSS.supports('animation-timeline', 'view()') || CSS.supports('animation-range', 'entry 0%'))

/** adds .revealed when the element scrolls into view */
export function useReveal<T extends HTMLElement>(once = true) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('revealed')
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('revealed')
            if (once) io.unobserve(e.target)
          } else if (!once) {
            e.target.classList.remove('revealed')
          }
        }
      },
      { threshold: 0.12 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [once])
  return ref
}

export function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  const ref = useReveal<HTMLDivElement>()
  return (
    <div ref={ref} className={`rj-reveal ${className}`.trim()} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  )
}

/** translateY drift keyed to the element's viewport position */
export function useParallax<T extends HTMLElement>(shift = 24) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || supportsViewTimeline) return // pure-CSS path owns it
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        const r = el.getBoundingClientRect()
        if (r.bottom < 0 || r.top > window.innerHeight) return
        const mid = r.top + r.height / 2 - window.innerHeight / 2
        el.style.transform = `translateY(${((-mid / window.innerHeight) * shift).toFixed(2)}px)`
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true })
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [shift])
  return ref
}

export function Parallax({
  children,
  shift = 24,
  className = '',
}: {
  children: ReactNode
  shift?: number
  className?: string
}) {
  const ref = useParallax<HTMLDivElement>(shift)
  return (
    <div ref={ref} className={`rj-parallax ${className}`.trim()} style={{ '--rj-parallax-shift': `${shift}px` } as CSSProperties}>
      {children}
    </div>
  )
}
