// packages/web/test/statsModel.test.ts — tone buckets for the command
// center's agent-record strip (cc.stats): ≥70 green, 40–69 amber, <40 red.
// The strip's i18n keys ride the zh/en parity contract (i18n.test.ts).
import { describe, expect, test } from 'vitest'
import { statsTone } from '../src/views/statsModel'

describe('statsTone', () => {
  test('≥70% is good, exact boundary included', () => {
    expect(statsTone(100)).toBe('good')
    expect(statsTone(70)).toBe('good')
  })

  test('40–69% is mid, exact lower boundary included', () => {
    expect(statsTone(69)).toBe('mid')
    expect(statsTone(50)).toBe('mid')
    expect(statsTone(40)).toBe('mid')
  })

  test('<40% is bad, including 0 for a fully-failing agent', () => {
    expect(statsTone(39)).toBe('bad')
    expect(statsTone(0)).toBe('bad')
  })
})
