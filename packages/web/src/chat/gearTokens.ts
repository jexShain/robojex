// packages/web/src/chat/gearTokens.ts — pure helpers for `@<gear>` mention
// tokens in the chat input: detection of the token being typed (drives the
// InputBar @ menu) and strip-on-send extraction (apply the last gear, remove
// every token from the outgoing text).

import type { GearId } from '../state/types'
import { GEAR_LEVELS } from '../state/types'

const GEAR_SET = new Set<string>(GEAR_LEVELS)

/** A gear mention: `@id` at line start or right after whitespace. */
const TOKEN_RE = /(^|\s)@([a-zA-Z]+)/g
/** Same shape anchored to the end of the value (menu trigger). */
const TRAILING_RE = /(^|\s)@([a-zA-Z]*)$/

/** Strip every valid `@<gear>` token from the text and report the LAST one.
 * Invalid mentions (`@foo`) and mid-word `@` (emails: `a@turbo.com`) pass
 * through untouched; each stripped token takes its leading blank with it so
 * spacing stays natural. */
export function extractGearTokens(input: string): { text: string; gear: GearId | null } {
  let gear: GearId | null = null
  let out = ''
  let last = 0
  for (const m of input.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0
    const word = (m[2] ?? '').toLowerCase()
    if (!GEAR_SET.has(word)) continue
    gear = word as GearId
    out += input.slice(last, idx)
    last = idx + m[0].length
  }
  return { text: (out + input.slice(last)).trim(), gear }
}

export interface TrailingMention {
  /** index of the `@` character inside the value */
  at: number
  /** letters typed after the @ (may be empty) */
  typed: string
}

/** Detect a gear mention being typed at the END of the value — the InputBar
 * menu trigger. Null when the value does not end in ` @…`. */
export function trailingMention(value: string): TrailingMention | null {
  const m = TRAILING_RE.exec(value)
  if (!m) return null
  return { at: m.index + m[1].length, typed: m[2] ?? '' }
}
