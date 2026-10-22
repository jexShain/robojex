// packages/web/test/desktop.test.ts — the tray-status payload contract the
// Electron shell consumes (T8): gear id -> numeric level, emoji label, and
// the graceful no-op path when window.robojex is absent (plain browser).
import { describe, expect, test } from 'vitest'
import type { GearDef } from '../src/state/types'
import { trayStatusFor, pushTrayStatus, hasAutostartBridge, readAutostart, writeAutostart } from '../src/state/desktop'

const gears: GearDef[] = [
  { id: 'eco', level: 1, name: '省电', emoji: '🌱', tickMs: 300_000, decideMaxTokens: 2048, patrolEvery: 5, desc: '', cost: '' },
  { id: 'focused', level: 3, name: '专注', emoji: '🎯', tickMs: 20_000, decideMaxTokens: 8192, patrolEvery: 1, desc: '', cost: '' },
]

describe('trayStatusFor', () => {
  test('catalog gears map id -> level, label carries the emoji', () => {
    const st = trayStatusFor('focused', gears, true)
    expect(st.gear).toBe(3)
    expect(st.connected).toBe(true)
    expect(st.label).toContain('🎯')
  })

  test('unknown catalog ids fall back to the static GEAR_FALLBACK table', () => {
    expect(trayStatusFor('turbo', [], true).gear).toBe(4)
    expect(trayStatusFor('dormant', [], false).gear).toBe(0)
  })

  test('unheard gear ids default to balanced (2) — never crashes the shell radios', () => {
    const st = trayStatusFor('alien-gear', [], false)
    expect(st.gear).toBe(2)
    expect(st.connected).toBe(false)
    expect(typeof st.label).toBe('string')
  })
})

describe('bridge absence (plain browser / node test env)', () => {
  test('no window.robojex: every call is a silent no-op, never a throw', () => {
    expect(hasAutostartBridge()).toBe(false)
    expect(() => pushTrayStatus({ gear: 2, label: '⚖️ 均衡', connected: true })).not.toThrow()
  })

  test('autostart read/write resolve null instead of rejecting', async () => {
    await expect(readAutostart()).resolves.toBeNull()
    await expect(writeAutostart(true)).resolves.toBeNull()
  })
})
