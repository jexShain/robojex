// packages/web/src/views/timefmt.ts — local-time formatting shared by Board
// and Agenda. Wire times are epoch ms (board v2 contract); rendering is local
// time — the hello.now offset kept on the store absorbs server clock skew.

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** One local day, fixed 24h — percent math below divides by this constant. */
export const DAY_MS = 86_400_000

/** Local midnight (epoch ms) of the day containing `ms`. */
export function dayStartOf(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `HH:MM` in local time. */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Same calendar day as `ref` → `HH:MM`; otherwise `MM-DD HH:MM`. */
export function fmtStamp(ms: number, ref: number): string {
  if (dayStartOf(ms) === dayStartOf(ref)) return fmtClock(ms)
  const d = new Date(ms)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(ms)}`
}

/** Day-view header label, `Aug 20` style. */
export function fmtDayLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`
}

/** Days-column header pieces: two-digit day-of-month + short weekday. */
export function dayColHead(ms: number): { day: string; weekday: string } {
  const d = new Date(ms)
  return {
    day: pad2(d.getDate()),
    weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
  }
}
