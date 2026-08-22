// packages/web/test/gearTokens.test.ts — pure tests for the InputBar `@<gear>`
// mention helpers: strip-on-send extraction (last token wins, all removed,
// spacing stays natural) and the trailing-mention detector driving the menu.
import { describe, expect, test } from 'vitest'
import { extractGearTokens, trailingMention } from '../src/chat/gearTokens'

describe('extractGearTokens', () => {
  test('strips a line-start token and reports the gear', () => {
    expect(extractGearTokens('@turbo 帮我查一下')).toEqual({ text: '帮我查一下', gear: 'turbo' })
  })

  test('token after a space counts; mid-word @ does not (emails)', () => {
    expect(extractGearTokens('hello @eco world')).toEqual({ text: 'hello world', gear: 'eco' })
    expect(extractGearTokens('mail a@turbo.com')).toEqual({ text: 'mail a@turbo.com', gear: null })
  })

  test('multiple tokens: strips all, applies the last', () => {
    expect(extractGearTokens('@eco 先查 @turbo 再写')).toEqual({ text: '先查 再写', gear: 'turbo' })
  })

  test('mention-only input empties the text but keeps the gear', () => {
    expect(extractGearTokens('@balanced')).toEqual({ text: '', gear: 'balanced' })
  })

  test('unknown mention passes through untouched', () => {
    expect(extractGearTokens('check @foo bar')).toEqual({ text: 'check @foo bar', gear: null })
    expect(extractGearTokens('partial @tur works?')).toEqual({ text: 'partial @tur works?', gear: null })
  })

  test('no tokens → text unchanged', () => {
    expect(extractGearTokens('plain text')).toEqual({ text: 'plain text', gear: null })
    expect(extractGearTokens('')).toEqual({ text: '', gear: null })
  })

  test('newline counts as a leading blank', () => {
    expect(extractGearTokens('line1\n@eco\nline2')).toEqual({ text: 'line1\nline2', gear: 'eco' })
  })

  test('matching is case-insensitive', () => {
    expect(extractGearTokens('@TURBO go')).toEqual({ text: 'go', gear: 'turbo' })
  })

  test('token glued to the previous token only matches the first', () => {
    // the second @ follows a word character, so it is not a mention
    expect(extractGearTokens('@eco@turbo')).toEqual({ text: '@turbo', gear: 'eco' })
  })
})

describe('trailingMention', () => {
  test('detects a bare @ at the end (line start or after space)', () => {
    expect(trailingMention('@')).toEqual({ at: 0, typed: '' })
    expect(trailingMention('hello @')).toEqual({ at: 6, typed: '' })
    expect(trailingMention('line\n@')).toEqual({ at: 5, typed: '' })
  })

  test('captures the letters typed after the @', () => {
    expect(trailingMention('go @tu')).toEqual({ at: 3, typed: 'tu' })
    expect(trailingMention('@TUR')).toEqual({ at: 0, typed: 'TUR' })
  })

  test('null when @ is mid-word, not trailing, or followed by a space', () => {
    expect(trailingMention('a@')).toBeNull()
    expect(trailingMention('@turbo hello')).toBeNull()
    expect(trailingMention('go @turbo ')).toBeNull()
    expect(trailingMention('plain')).toBeNull()
  })
})
