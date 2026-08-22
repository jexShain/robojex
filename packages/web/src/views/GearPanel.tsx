// packages/web/src/views/GearPanel.tsx — 「挡位驾驶舱」cockpit view.
// Top: current-gear dial (SVG semicircle, 0–4 ticks, spring needle, gear
// gradient arc) + gear facts + quick switch. Middle: 7-day usage bars
// (GET /api/usage?days=7) + budget fuel. Bottom: ThinkingStream (reasoning
// timeline, incremental ingest). The header gear spins while streaming or a
// decision is pending.

import { useEffect, useMemo, useState } from 'react'
import * as api from '../state/api'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { DayUsage } from '../state/types'
import { gearsOrFallback, localizeGears } from './gearDefs'
import { ThinkingStream } from './ThinkingStream'
import './cockpit.css'

/* ── dial geometry ── */

const CX = 120
const CY = 118
const R = 92

const angleFor = (level: number): number => -90 + (level / 4) * 180

function pt(r: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180
  return { x: CX + r * Math.sin(rad), y: CY - r * Math.cos(rad) }
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function fmtTick(ms: number, t: (key: string) => string): string {
  if (ms <= 0) return t('cp.tickStop')
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 1000)} s`
}

function GearDial({ level, emoji }: { level: number; emoji: string }) {
  const { t } = useT()
  const arc = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${CX + R} ${CY}`
  const frac = (level / 4) * 100
  const ticks = [0, 1, 2, 3, 4].map((lv) => {
    const a = angleFor(lv)
    return { lv, a, outer: pt(R + 7, a), inner: pt(R - 7, a), label: pt(R - 24, a) }
  })
  return (
    <svg
      className="cp-dial-svg"
      data-testid="gear-dial"
      viewBox="0 0 240 136"
      role="img"
      aria-label={fill(t('cp.dialAria'), { n: level })}
    >
      <defs>
        <linearGradient id="cpGearGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--rj-gear-0)" />
          <stop offset="25%" stopColor="var(--rj-gear-1)" />
          <stop offset="50%" stopColor="var(--rj-gear-2)" />
          <stop offset="75%" stopColor="var(--rj-gear-3)" />
          <stop offset="100%" stopColor="var(--rj-gear-4)" />
        </linearGradient>
      </defs>
      {/* track */}
      <path d={arc} className="cp-arc-bg" />
      {/* active arc up to the current level (gear gradient) */}
      <path
        d={arc}
        className="cp-arc-fg"
        stroke="url(#cpGearGrad)"
        pathLength={100}
        strokeDasharray={`${frac} 100`}
      />
      {/* tick marks + numeric labels */}
      {ticks.map((t) => (
        <g key={t.lv}>
          <line
            x1={t.inner.x}
            y1={t.inner.y}
            x2={t.outer.x}
            y2={t.outer.y}
            className={`cp-tick${t.lv <= level ? ' lit' : ''}`}
          />
          <text x={t.label.x} y={t.label.y + 3} textAnchor="middle" className="cp-tick-txt">
            {t.lv}
          </text>
        </g>
      ))}
      {/* needle: rotates with the 600ms spring */}
      <g
        className="cp-needle"
        style={{ transform: `rotate(${angleFor(level)}deg)` }}
      >
        <line x1={CX} y1={CY} x2={CX} y2={CY - 74} />
        <circle cx={CX} cy={CY - 74} r={3.5} />
      </g>
      <circle cx={CX} cy={CY} r={7} className="cp-hub" />
      <text x={CX} y={CY - 34} textAnchor="middle" className="cp-emoji">
        {emoji}
      </text>
    </svg>
  )
}

function UsageChart() {
  const { t } = useT()
  const [usage, setUsage] = useState<DayUsage[] | null>(null)

  useEffect(() => {
    let alive = true
    api
      .getUsage(7)
      .then((u) => {
        if (alive) setUsage(u)
      })
      .catch(() => {
        if (alive) setUsage([])
      })
    return () => {
      alive = false
    }
  }, [])

  if (usage === null) {
    return (
      <div className="cp-usage" data-testid="usage-chart">
        <div className="cp-charts rj-skeleton" style={{ height: 88 }} />
      </div>
    )
  }

  const totals = usage.map((d) => d.tokensIn + d.tokensOut)
  const max = Math.max(...totals, 1)
  const today = totals.length > 0 ? totals[totals.length - 1] : 0
  const week = totals.reduce((a, b) => a + b, 0)

  return (
    <div className="cp-usage" data-testid="usage-chart">
      <div className="cp-usage-head">
        <span className="cp-sec-title">{t('cp.todayUsage')}</span>
        <span className="cp-usage-today">
          {fmtTok(today)} tok<span className="cp-usage-week">{fill(t('cp.weekUsage'), { n: fmtTok(week) })}</span>
        </span>
      </div>
      <div className="cp-charts">
        {usage.length === 0 ? (
          <div className="cp-usage-empty">{t('cp.noUsage')}</div>
        ) : (
          usage.map((d, i) => {
            const total = d.tokensIn + d.tokensOut
            const h = Math.max(3, Math.round((total / max) * 100))
            const md = d.day.slice(5).replace('-', '/')
            return (
              <div
                key={d.day}
                className={`uc-bar${i === usage.length - 1 ? ' today' : ''}`}
                data-tip={`${md} · ${fmtTok(d.tokensIn)} in + ${fmtTok(d.tokensOut)} out = ${fmtTok(total)} tok · ${d.calls} calls`}
              >
                <div className="uc-fill" style={{ height: `${h}%` }} />
                <span className="uc-day">{md}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function BudgetFuel() {
  const { state } = useStore()
  const { t } = useT()
  const b = state.budget
  if (!b) {
    return (
      <div className="cp-fuel">
        <div className="cp-sec-title">{t('cp.budget')}</div>
        <div className="cp-fuel-line dim">{t('cp.waitCore')}</div>
      </div>
    )
  }
  const burn = b.mode === 'burn'
  const pct = !burn && b.dailyTokens > 0 ? Math.min(100, Math.round((b.spentToday / b.dailyTokens) * 100)) : 0
  return (
    <div className="cp-fuel">
      <div className="cp-fuel-head">
        <span className="cp-sec-title">{t('cp.budgetFuel')}</span>
        <span className="cp-fuel-label">
          {burn ? (
            <>
              <b className="infty">∞</b> {fill(t('cp.burnToday'), { n: fmtTok(b.spentToday) })}
            </>
          ) : (
            fill(t('cp.fuelLabel'), { a: fmtTok(b.spentToday), b: fmtTok(b.dailyTokens), p: pct })
          )}
        </span>
      </div>
      {burn ? (
        <div className="cp-fuel-bar burn" />
      ) : (
        <div className="cp-fuel-bar">
          <div className={`cp-fuel-fill${pct >= 80 ? ' warn' : ''}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="cp-fuel-line dim">{b.line}</div>
    </div>
  )
}

export function GearPanel() {
  const { state, changeGear } = useStore()
  const { t } = useT()
  const gears = useMemo(() => localizeGears(gearsOrFallback(state.gears), t), [state.gears, t])
  const cur = useMemo(
    () => gears.find((g) => g.id === state.gear) ?? gears[0],
    [gears, state.gear],
  )
  if (!cur) return null
  const busy = state.stream.status === 'streaming' || state.waiting

  return (
    <div className="cockpit">
      {/* ── dial + facts ── */}
      <section className="cp-top">
        <div className="cp-dial-wrap">
          <GearDial level={cur.level} emoji={cur.emoji} />
        </div>
        <div className="cp-facts">
          <div className="cp-facts-title">
            <span className={`cp-gear-icon${busy ? ' busy' : ''}`} aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <circle cx="8" cy="8" r="2.1" />
                <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
              </svg>
            </span>
            <span className="cp-cur-emoji">{cur.emoji}</span>
            <span className="cp-cur-name" style={{ color: `var(--rj-gear-${cur.level})` }}>
              {cur.name}
            </span>
          </div>
          <p className="cp-cur-desc">{cur.desc}</p>
          <div className="cp-facts-kv">
            <span className="k">cost</span>
            <span className="v">{cur.cost}</span>
            <span className="k">tick</span>
            <span className="v">
              {fmtTick(cur.tickMs, t)}{fill(t('cp.applied'), { x: fmtTick(state.gearAppliedTickMs, t) })}
            </span>
            <span className="k">decide</span>
            <span className="v">{cur.decideMaxTokens > 0 ? `${cur.decideMaxTokens} tok` : '—'}</span>
            <span className="k">patrol</span>
            <span className="v">
              {cur.patrolEvery > 0 ? fill(t('cp.patrolEvery'), { n: cur.patrolEvery }) : t('cp.patrolOff')}
            </span>
          </div>
          <div className="cp-quick" role="group" aria-label={t('cp.quickAria')}>
            {gears.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`cp-quick-btn${g.id === state.gear ? ' on' : ''}`}
                style={g.id === state.gear ? { borderColor: `var(--rj-gear-${g.level})` } : undefined}
                onClick={() => void changeGear(g.id)}
                aria-pressed={g.id === state.gear}
                title={`${g.name} · ${g.desc}`}
              >
                <span>{g.emoji}</span>
                <span className="cp-quick-name">{g.name}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── usage + budget ── */}
      <section className="cp-mid">
        <UsageChart />
        <BudgetFuel />
      </section>

      {/* ── reasoning stream ── */}
      <section className="cp-stream">
        <div className="cp-stream-head cp-sec-title">{t('cp.streamTitle')}</div>
        <ThinkingStream embedded />
      </section>
    </div>
  )
}
