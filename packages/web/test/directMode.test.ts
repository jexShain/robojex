// packages/web/test/directMode.test.ts — pure tests for the SPEC §1 direct
// fallback: localStorage prefs parsing (parseDirectPrefs — per-field
// recovery from half-written payloads), the SSE chunk parser used by
// chatStreamDirect (DeepSeek reasoning_content/content/usage/[DONE]), and
// the directEnabled gate (direct without a key stays on the gateway).
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_DIRECT_BASE,
  DEFAULT_DIRECT_PREFS,
  directEnabled,
  parseDirectPrefs,
  parseDirectSSEChunk,
} from '../src/state/api'

describe('parseDirectPrefs', () => {
  test('null / garbage / non-object payloads fall back to defaults', () => {
    expect(parseDirectPrefs(null)).toEqual(DEFAULT_DIRECT_PREFS)
    expect(parseDirectPrefs('')).toEqual(DEFAULT_DIRECT_PREFS)
    expect(parseDirectPrefs('{oops')).toEqual(DEFAULT_DIRECT_PREFS)
    expect(parseDirectPrefs('42')).toEqual(DEFAULT_DIRECT_PREFS)
    expect(parseDirectPrefs('"x"')).toEqual(DEFAULT_DIRECT_PREFS)
  })

  test('round-trips a full payload', () => {
    const raw = JSON.stringify({ mode: 'direct', baseUrl: 'https://x/v1 ', apiKey: 'sk-abc', model: ' m ' })
    expect(parseDirectPrefs(raw)).toEqual({
      mode: 'direct',
      baseUrl: 'https://x/v1',
      apiKey: 'sk-abc',
      model: 'm',
    })
  })

  test('unknown mode falls back to gateway; apiKey is kept verbatim', () => {
    const p = parseDirectPrefs(JSON.stringify({ mode: 'tunnel', apiKey: ' k1 ' }))
    expect(p.mode).toBe('gateway')
    expect(p.apiKey).toBe(' k1 ')
  })

  test('blank baseUrl falls back to the DeepSeek default', () => {
    expect(parseDirectPrefs(JSON.stringify({ mode: 'direct', baseUrl: '   ' })).baseUrl).toBe(DEFAULT_DIRECT_BASE)
    expect(parseDirectPrefs(JSON.stringify({ mode: 'direct' })).baseUrl).toBe(DEFAULT_DIRECT_BASE)
  })

  test('missing fields recover individually without bricking the rest', () => {
    const p = parseDirectPrefs(JSON.stringify({ mode: 'direct', baseUrl: 'https://y/v1' }))
    expect(p).toEqual({ mode: 'direct', baseUrl: 'https://y/v1', apiKey: '', model: '' })
  })
})

describe('parseDirectSSEChunk', () => {
  test('maps reasoning_content / content deltas onto stream events', () => {
    const { events, rest } = parseDirectSSEChunk(
      'data: {"choices":[{"delta":{"reasoning_content":"想想"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
    )
    expect(events).toEqual([
      { type: 'reasoning', delta: '想想' },
      { type: 'content', delta: '你好' },
    ])
    expect(rest).toBe('')
  })

  test('one chunk carrying both fields emits reasoning before content', () => {
    const { events } = parseDirectSSEChunk(
      'data: {"choices":[{"delta":{"reasoning_content":"r","content":"c"}}]}\n\n',
    )
    expect(events.map((e) => e.type)).toEqual(['reasoning', 'content'])
  })

  test('usage chunk maps prompt/completion tokens (choices may be empty)', () => {
    const { events } = parseDirectSSEChunk(
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n',
    )
    expect(events).toEqual([{ type: 'usage', tokensIn: 12, tokensOut: 34 }])
  })

  test('usage with missing completion_tokens counts as 0, usage:null is skipped', () => {
    expect(
      parseDirectSSEChunk('data: {"usage":{"prompt_tokens":7}}\n\n').events,
    ).toEqual([{ type: 'usage', tokensIn: 7, tokensOut: 0 }])
    expect(parseDirectSSEChunk('data: {"choices":null,"usage":null}\n\n').events).toEqual([])
  })

  test('[DONE] maps to a done event', () => {
    expect(parseDirectSSEChunk('data: [DONE]\n\n').events).toEqual([{ type: 'done' }])
  })

  test('empty deltas, comments and non-data lines produce nothing', () => {
    const buf = ': keepalive\n\ndata: {"choices":[{"delta":{"content":""}}]}\n\nevent: ping\ndata: {"choices":[{"delta":{"reasoning_content":""}}]}\n\n'
    expect(parseDirectSSEChunk(buf).events).toEqual([])
  })

  test('invalid JSON data lines are skipped, valid siblings still parse', () => {
    const { events } = parseDirectSSEChunk(
      'data: {"choices":[{"delta":{"con\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    )
    expect(events).toEqual([{ type: 'content', delta: 'ok' }])
  })

  test('incomplete tail is returned as rest; completed across calls it parses', () => {
    const first = parseDirectSSEChunk('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choi')
    expect(first.events).toEqual([{ type: 'content', delta: 'a' }])
    expect(first.rest).toBe('data: {"choi')
    const second = parseDirectSSEChunk(first.rest + 'ces":[{"delta":{"content":"b"}}]}\n\n')
    expect(second.events).toEqual([{ type: 'content', delta: 'b' }])
    expect(second.rest).toBe('')
  })

  test('buffer with no separator yet is all rest', () => {
    expect(parseDirectSSEChunk('data: {"partial"')).toEqual({ events: [], rest: 'data: {"partial"' })
  })

  test('CRLF separators and CRLF line endings parse like LF', () => {
    const { events, rest } = parseDirectSSEChunk(
      'data: {"choices":[{"delta":{"content":"c"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    )
    expect(events).toEqual([{ type: 'content', delta: 'c' }, { type: 'done' }])
    expect(rest).toBe('')
  })
})

describe('directEnabled', () => {
  test('direct mode requires a non-blank key', () => {
    expect(directEnabled({ mode: 'gateway', baseUrl: DEFAULT_DIRECT_BASE, apiKey: 'sk-1', model: '' })).toBe(false)
    expect(directEnabled({ mode: 'direct', baseUrl: DEFAULT_DIRECT_BASE, apiKey: '', model: '' })).toBe(false)
    expect(directEnabled({ mode: 'direct', baseUrl: DEFAULT_DIRECT_BASE, apiKey: '   ', model: '' })).toBe(false)
    expect(directEnabled({ mode: 'direct', baseUrl: DEFAULT_DIRECT_BASE, apiKey: ' sk-1 ', model: '' })).toBe(true)
  })
})
