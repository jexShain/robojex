// packages/web/src/frame/HudBar.tsx — jex status cluster embedded in the top
// bar's right side: heartbeat lamp (breathing green while the WS is live),
// mode pill (click cycles observe → assist → full), budget fuel gauge
// (burn shows ∞ + today's spend), and a server-aligned HH:MM clock.
// Reads the store only; no props.

import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { Mode } from '../state/types'

const MODE_CYCLE: Mode[] = ['observe', 'assist', 'full']

function fmtClock(now: number): string {
  const d = new Date(now)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function HudBar() {
  const { state, setMode } = useStore()
  const [, setTick] = useState(0)

  // The clock advances on its own 30s heartbeat; store frames also re-render.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((x) => x + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const live = state.conn === 'live'
  const serverNow = Date.now() + (state.clockOffset ?? 0)
  const b = state.budget
  const burn = b?.mode === 'burn'
  const dailyTokens = b?.dailyTokens ?? 0
  const spentToday = b?.spentToday ?? 0
  const pct = !burn && dailyTokens > 0 ? Math.min(100, Math.round((spentToday / dailyTokens) * 100)) : 0

  const cycleMode = (): void => {
    const idx = MODE_CYCLE.indexOf(state.mode)
    setMode(MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] ?? 'observe')
  }

  return (
    <div className="rj-hud" role="status" aria-label="jex status">
      <span
        className={`hud-heart${live ? ' alive' : ''}`}
        data-testid="hud-heart"
        title={live ? 'jex 心跳 — WS live' : `connection: ${state.conn}`}
      />
      <button
        type="button"
        className={`hud-mode ${state.mode}`}
        onClick={cycleMode}
        title={`mode: ${state.mode} — 点击切换 observe → assist → full`}
      >
        {state.mode}
      </button>
      <span data-testid="hud-budget" title={b ? `${b.line} · today ${spentToday} / ${dailyTokens} tok` : 'budget unknown'}>
        {b && burn ? (
          <span className="hud-burn">
            <span className="infty">∞</span>
            <span>{fmtTokens(spentToday)} tok</span>
          </span>
        ) : (
          <span className="hud-fuel">
            <span
              className={`hud-fuel-fill${pct >= 80 ? ' warn' : ''}`}
              style={{ width: `${pct}%`, display: 'block' }}
            />
          </span>
        )}
      </span>
      <time className="hud-clock" dateTime={new Date(serverNow).toISOString()}>
        {fmtClock(serverNow)}
      </time>
    </div>
  )
}
