// packages/web/test/i18n.test.ts — dictionary contract: zh is the source of
// truth, en must mirror its key set exactly; translate falls back zh → key;
// fill interpolates {tokens}; resolveLang honors the zh* navigator rule.
import { afterEach, describe, expect, test, vi } from 'vitest'
import { zh } from '../src/i18n/zh'
import { en } from '../src/i18n/en'
import { fill, resolveLang, translate } from '../src/i18n/event'

describe('dictionaries', () => {
  test('en has exactly the same key set as zh (no missing, no extra)', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  test('every value is a non-empty string', () => {
    for (const [k, v] of Object.entries(zh)) expect(v, `zh.${k}`).toBeTruthy()
    for (const [k, v] of Object.entries(en)) expect(v, `en.${k}`).toBeTruthy()
  })

  test('placeholder tokens match between zh and en', () => {
    const tokens = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const k of Object.keys(zh)) {
      expect(tokens(en[k] ?? ''), `en.${k}`).toEqual(tokens(zh[k] ?? ''))
    }
  })
})

describe('translate', () => {
  test('explicit lang resolves through that dictionary', () => {
    expect(translate('view.command', 'zh')).toBe('指挥中心')
    expect(translate('view.command', 'en')).toBe('Command Center')
  })

  test('missing key returns the key itself (and never blanks the UI)', () => {
    expect(translate('no.such.key', 'en')).toBe('no.such.key')
    expect(translate('no.such.key', 'zh')).toBe('no.such.key')
  })
})

describe('fill', () => {
  test('interpolates tokens and leaves unknown ones intact', () => {
    expect(fill('{n} 任务', { n: 3 })).toBe('3 任务')
    expect(fill('{n} tasks', { n: 3 })).toBe('3 tasks')
    expect(fill('a {x} b {y}', { x: 1 })).toBe('a 1 b {y}')
    expect(fill('no tokens', {})).toBe('no tokens')
  })
})

describe('resolveLang', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('explicit prefs resolve to themselves', () => {
    expect(resolveLang('zh')).toBe('zh')
    expect(resolveLang('en')).toBe('en')
  })

  test('system resolves zh for any zh-* navigator language, en otherwise', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(resolveLang('system')).toBe('zh')
    vi.stubGlobal('navigator', { language: 'zh-TW' })
    expect(resolveLang('system')).toBe('zh')
    vi.stubGlobal('navigator', { language: 'en-US' })
    expect(resolveLang('system')).toBe('en')
  })

  test('system tolerates a missing navigator (node) and stays deterministic', () => {
    vi.stubGlobal('navigator', undefined)
    expect(['zh', 'en']).toContain(resolveLang('system'))
  })
})
