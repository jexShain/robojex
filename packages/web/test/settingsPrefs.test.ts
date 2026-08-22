// packages/web/test/settingsPrefs.test.ts — pure tests for the renderer-local
// preference helpers exported from SettingsView: the four localStorage prefs
// (start view / density / font size / enter-send) parse defensively, the
// prefs-reset only touches the robojex-* allowlist (language survives), and
// applyBodyPrefs maps prefs onto body dataset attributes. Browser globals
// are stubbed before import because SettingsView pulls in theme.ts, which
// registers a module-level window listener (vitest runs in node).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

function mkStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  }
}

let storage: Storage

// stub BEFORE the top-level import: theme.ts registers a module-level
// window listener, so the module graph needs the globals at import time
vi.stubGlobal('window', {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
})
vi.stubGlobal('document', { body: { dataset: {} }, documentElement: { dataset: {} } })
storage = mkStorage()
vi.stubGlobal('localStorage', storage)

const sv = await import('../src/views/SettingsView')

beforeEach(() => {
  // fresh storage per test; the helpers read the global at call time
  storage = mkStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => {
  // keep window/document stubbed (module already imported); only reset storage
})

describe('parseStartView', () => {
  test('accepts the three valid values, defaults to last', () => {
    const { parseStartView } = sv
    expect(parseStartView('last')).toBe('last')
    expect(parseStartView('command')).toBe('command')
    expect(parseStartView('chat')).toBe('chat')
    expect(parseStartView(null)).toBe('last')
    expect(parseStartView('')).toBe('last')
    expect(parseStartView('cockpit')).toBe('last')
  })
})

describe('parseDensity / parseFontSize', () => {
  test('only the exact non-default string flips the pref', () => {
    expect(sv.parseDensity('compact')).toBe('compact')
    expect(sv.parseDensity('cozy')).toBe('cozy')
    expect(sv.parseDensity(null)).toBe('cozy')
    expect(sv.parseDensity('Compact')).toBe('cozy')

    expect(sv.parseFontSize('large')).toBe('large')
    expect(sv.parseFontSize('default')).toBe('default')
    expect(sv.parseFontSize(null)).toBe('default')
    expect(sv.parseFontSize('big')).toBe('default')
  })
})

describe('parseEnterSend', () => {
  test('defaults to on; only "0" turns it off', () => {
    expect(sv.parseEnterSend(null)).toBe(true)
    expect(sv.parseEnterSend('1')).toBe(true)
    expect(sv.parseEnterSend('0')).toBe(false)
    expect(sv.parseEnterSend('off')).toBe(true)
  })
})

describe('LOCAL_PREF_KEYS', () => {
  test('covers the four new prefs + legacy theme/model/direct, never lang', () => {
    expect(sv.LOCAL_PREF_KEYS).toEqual(
      expect.arrayContaining([
        'robojex-startview',
        'robojex-density',
        'robojex-fontsize',
        'robojex-enter-send',
        'robojex-theme',
        'robojex-model',
        'robojex-direct',
      ]),
    )
    expect(sv.LOCAL_PREF_KEYS).not.toContain('robojex-lang')
  })
})

describe('clearLocalPrefs', () => {
  test('removes only present robojex-* keys and returns the count', () => {
    storage.setItem('robojex-theme', 'dark')
    storage.setItem('robojex-density', 'compact')
    storage.setItem('robojex-lang', 'zh') // must survive
    storage.setItem('unrelated', 'x')
    const n = sv.clearLocalPrefs(storage)
    expect(n).toBe(2)
    expect(storage.getItem('robojex-theme')).toBeNull()
    expect(storage.getItem('robojex-density')).toBeNull()
    expect(storage.getItem('robojex-lang')).toBe('zh')
    expect(storage.getItem('unrelated')).toBe('x')
  })

  test('empty storage removes nothing', () => {
    expect(sv.clearLocalPrefs(storage)).toBe(0)
  })

  test('default parameter falls back to the global localStorage', () => {
    storage.setItem('robojex-model', 'deepseek-v4-flash')
    expect(sv.clearLocalPrefs()).toBe(1)
    expect(storage.getItem('robojex-model')).toBeNull()
  })
})

describe('applyBodyPrefs', () => {
  test('maps density + font size onto body dataset attributes', () => {
    sv.applyBodyPrefs('compact', 'large')
    const doc = (globalThis as { document?: { body: { dataset: Record<string, string> } } }).document
    expect(doc?.body.dataset.density).toBe('compact')
    expect(doc?.body.dataset.fontsize).toBe('large')
    sv.applyBodyPrefs('cozy', 'default')
    expect(doc?.body.dataset.density).toBe('cozy')
    expect(doc?.body.dataset.fontsize).toBe('default')
  })
})
