// packages/web/src/frame/HudBar.tsx — top status strip: heartbeat lamp, mode
// pill, budget fuel gauge, server-aligned clock, collapse-to-widget button.
// Reads store state (mode/budget/lastHud/clockOffset/transcript) only.

import { useStore } from '../state/store'

// Mode → status-lamp color. Mapped onto real semantic state tokens (the brief's
// --dsw-alias-accent-* names do not exist in tokens.css), with the brief's hex
// values retained as last-resort fallbacks per the task's allowance.
const MODE_COLOR: Record<string, string> = {
  observe: 'var(--dsw-alias-state-warn-primary, #d97706)',
  assist: 'var(--dsw-alias-state-business-primary, #5686fe)',
  full: 'var(--dsw-alias-state-error-primary, #dc2626)',
}

// One extra second on the minute so the display never appears frozen between
// ticks; updated each render which is fine — store updates drive renders.
function fmtClock(now: number): string {
  return new Date(now).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function HudBar({ onCollapse }: { onCollapse(): void }) {
  const { state: s } = useStore()
  const serverNow = Date.now() + (s.clockOffset ?? 0)
  // No `s.cycles` field exists; any hud notice or cycle transcript entry means
  // the core loop has produced traffic and is therefore alive.
  const alive = s.lastHud !== null || s.transcript.some((t) => t.kind === 'cycle')
  // budget is Budget | null; before the first hello it is null.
  const b = s.budget
  const dailyTokens = b?.dailyTokens ?? 0
  const spentToday = b?.spentToday ?? 0
  const pct = dailyTokens > 0 ? Math.min(100, Math.round((spentToday / dailyTokens) * 100)) : 0
  const budgetLabel = b ? `${spentToday}/${dailyTokens}` : '—/—'
  const mode = s.mode
  return (
    <header className="hud-bar" role="status" aria-label="jex status">
      <span
        className={`hud-heart${alive ? ' alive' : ''}`}
        title={alive ? 'jex heartbeat — loop live' : 'jex heartbeat — idle'}
      />
      <span
        className="hud-mode"
        style={{ background: MODE_COLOR[mode] ?? 'var(--dsw-alias-label-tertiary, #666)' }}
        title={`mode: ${mode}`}
      >
        {mode}
      </span>
      <div className="hud-fuel" title={`budget ${budgetLabel} (${pct}%)`}>
        <div className={`hud-fuel-fill${pct >= 80 ? ' warn' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <time className="hud-clock" dateTime={new Date(serverNow).toISOString()}>
        {fmtClock(serverNow)}
      </time>
      <button
        type="button"
        className="hud-collapse"
        onClick={onCollapse}
        title="collapse to widget"
        aria-label="collapse to widget"
      >
        ▁
      </button>
    </header>
  )
}
