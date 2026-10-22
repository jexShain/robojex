// packages/web/src/ui/Skeleton.tsx — skeleton-screen primitives (T6).
// Sizes ride inline styles; the shimmer sweep itself lives on .rj-skeleton
// in effects.css so reduced-motion stays a single CSS switch.
// LoadingVeil is the first-boot placeholder: it covers the frame (topbar
// excluded) from mount until the hello frame lands, then fades itself out.

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useStore } from '../state/store'

interface SkeletonProps {
  w?: number | string
  h?: number | string
  r?: number
  circle?: boolean
  className?: string
  style?: CSSProperties
}

export function Skeleton({ w = '100%', h = 14, r = 6, circle = false, className = '', style }: SkeletonProps) {
  return (
    <div
      className={`rj-skeleton${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{ width: w, height: h, borderRadius: circle ? '50%' : r, ...style }}
    />
  )
}

export function SkeletonRows({ n = 6, h = 14, gap = 10 }: { n?: number; h?: number; gap?: number }) {
  const rows: ReactNode[] = []
  for (let i = 0; i < n; i++) {
    // last-line-wins short so the block reads like real text, not a matrix
    const w = `${i % 4 === 3 ? 56 : i % 3 === 2 ? 72 : 90}%`
    rows.push(<Skeleton key={i} w={w} h={h} />)
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap }}>{rows}</div>
}

export function SkeletonBoard({ n = 6 }: { n?: number }) {
  const cards: ReactNode[] = []
  for (let i = 0; i < n; i++) cards.push(<Skeleton key={i} h={64} r={8} />)
  return <div className="rj-veil-cards">{cards}</div>
}

const VEIL_OUT_MS = 420

export function LoadingVeil(): ReactNode {
  const { state } = useStore()
  // hello frame is the single source of "booted": version '' until then
  const booting = state.version === '' && state.tasks.length === 0
  const bootedOnce = useRef(!booting)
  const [leaving, setLeaving] = useState(false)
  const [hidden, setHidden] = useState(false)

  if (booting) bootedOnce.current = false

  useEffect(() => {
    if (booting || hidden || leaving) return
    setLeaving(true)
    const t = window.setTimeout(() => setHidden(true), VEIL_OUT_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booting])

  if (hidden) return null
  if (!booting && !leaving && bootedOnce.current) return null

  return (
    <div className={`rj-skeleton-veil${leaving ? ' out' : ''}`} role="status" aria-label="loading">
      <div className="rj-veil-side">
        <Skeleton w={140} h={16} />
        <SkeletonRows n={8} h={12} gap={14} />
      </div>
      <div className="rj-veil-main">
        <SkeletonBoard n={6} />
        <div style={{ gridColumn: '1 / -1' }}>
          <SkeletonRows n={4} h={16} gap={16} />
        </div>
      </div>
    </div>
  )
}
