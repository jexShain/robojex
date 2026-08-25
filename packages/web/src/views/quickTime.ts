// packages/web/src/views/quickTime.ts — quick time syntax for the board's
// create box: type 「明天9点 检查磁盘 截止11点」 and the card is born with a
// slot, no second trip to the agenda. A closed syntax (today/tomorrow/day-
// after + H[:MM][点], optional 截止 suffix) keeps parsing deterministic —
// free-text NLP belongs to the chat butler, not a capture box.

export interface QuickTime {
  title: string
  scheduledAt?: number
  dueAt?: number
}

const DAY_WORDS: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2 }

function dayStartLocal(offset: number, now: number): number {
  // derive from the CALLER's clock: the `now` parameter is the reference the
  // roll-to-tomorrow check already uses — mixing it with the real wall clock
  // made day words resolve against today() no matter what `now` said
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime() + offset * 86_400_000
}

function at(day0: number, h: number, m: number): number {
  return day0 + (h * 60 + m) * 60_000
}

/**
 * Parse a capture-box line. Returns null when no leading time token exists
 * (a plain create). A bare HH:MM that already passed today rolls to tomorrow
 * — 「14:30 咖啡」 at 15:00 means the next one.
 */
export function parseQuickTime(input: string, now = Date.now()): QuickTime | null {
  const head = input.match(
    /^\s*(今天|明天|后天)?\s*(\d{1,2})(?::(\d{2}))?点?\s+(.+)$/,
  )
  if (!head) return null
  const [, dayWord, hStr, mStr, rest0] = head
  const h = Number(hStr)
  const m = mStr !== undefined ? Number(mStr) : 0
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  let day0 = dayStartLocal(dayWord ? DAY_WORDS[dayWord] : 0, now)
  let scheduledAt = at(day0, h, m)
  if (!dayWord && scheduledAt <= now) {
    day0 += 86_400_000
    scheduledAt += 86_400_000
  }
  // optional due suffix on the tail: 「… 截止18:30」/「… due 18:30」
  let title = rest0.trim()
  let dueAt: number | undefined
  const tail = title.match(/\s+(?:截止|due)\s*(\d{1,2})(?::(\d{2}))?点?\s*$/)
  if (tail) {
    const dh = Number(tail[1])
    const dm = tail[2] !== undefined ? Number(tail[2]) : 0
    if (dh >= 0 && dh <= 23 && dm >= 0 && dm <= 59) {
      dueAt = at(day0, dh, dm)
      if (dueAt > scheduledAt) title = title.slice(0, tail.index).trim()
      else dueAt = undefined // inverted range: drop the due rather than guess
    }
  }
  return { title, scheduledAt, ...(dueAt !== undefined ? { dueAt } : {}) }
}
