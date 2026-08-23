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

const CN_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** Day-view header label: `8月20日` (zh, default) / `Aug 20` (en). */
export function fmtDayLabel(ms: number, lang: 'zh' | 'en' = 'zh'): string {
  const d = new Date(ms)
  return lang === 'en'
    ? `${d.toLocaleDateString('en-US', { month: 'short' })} ${d.getDate()}`
    : `${d.getMonth() + 1}月${d.getDate()}日`
}

/** Days-column header pieces: two-digit day + single-char weekday (一…日). */
export function dayColHead(ms: number, lang: 'zh' | 'en' = 'zh'): { day: string; weekday: string } {
  const d = new Date(ms)
  return {
    day: pad2(d.getDate()),
    weekday: lang === 'en' ? d.toLocaleDateString('en-US', { weekday: 'short' }) : CN_WEEKDAYS[d.getDay()],
  }
}
