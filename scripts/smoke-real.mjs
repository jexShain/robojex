// scripts/smoke-real.mjs — end-to-end smoke against a RUNNING ceo-core with
// the real DeepSeek key from runtime/config.json. Validates: conversations
// CRUD, SSE streaming (reasoning + content + usage + title), gear hot-swap,
// models list. Exit code 0 = all green.
//
// Usage: node scripts/smoke-real.mjs [baseUrl]   (default http://127.0.0.1:7620)

const BASE = process.argv[2] || 'http://127.0.0.1:7620'

let passed = 0
let failed = 0
function ok(label, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // SSE or non-JSON
  }
  return { status: res.status, json, text }
}

console.log(`\nsmoke-real → ${BASE}\n`)

// 1. state + version
{
  const r = await j('GET', '/api/state')
  ok('GET /api/state', r.status === 200 && r.json?.version, `version=${r.json?.version} gear=${r.json?.gear}`)
}

// 2. conversations CRUD
let convId = ''
{
  const r = await j('POST', '/api/conversations', {})
  ok('POST /api/conversations', r.status === 200 || r.status === 201, `id=${r.json?.id?.slice(0, 8)}`)
  convId = r.json?.id
  const list = await j('GET', '/api/conversations')
  ok('GET /api/conversations', Array.isArray(list.json?.conversations), `${list.json?.conversations?.length} convs`)
  const patch = await j('PATCH', `/api/conversations/${convId}`, { title: '冒烟测试' })
  ok('PATCH rename', patch.json?.title === '冒烟测试')
  const pin = await j('PATCH', `/api/conversations/${convId}`, { pinned: true })
  ok('PATCH pin', pin.json?.pinned === 1 || pin.json?.pinned === true)
}

// 3. streaming chat (real DeepSeek)
{
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ conversationId: convId, text: '用一句话说明什么是二分查找' }),
  })
  ok('POST /api/chat/stream 200', res.status === 200, `content-type=${res.headers.get('content-type')}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let sawMeta = false, sawReasoning = false, sawContent = false, sawUsage = false, sawTitle = false, sawDone = false
  let contentLen = 0, reasoningLen = 0
  const t0 = Date.now()
  outer: for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let sep
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        let ev
        try {
          ev = JSON.parse(payload)
        } catch {
          continue
        }
        if (ev.type === 'meta') sawMeta = true
        if (ev.type === 'reasoning') { sawReasoning = true; reasoningLen += ev.delta.length }
        if (ev.type === 'content') { sawContent = true; contentLen += ev.delta.length }
        if (ev.type === 'usage') sawUsage = true
        if (ev.type === 'title') sawTitle = true
        if (ev.type === 'error') { ok('stream error event', false, ev.message); break outer }
        if (ev.type === 'done') { sawDone = true }
      }
    }
    if (sawDone) break
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  ok('SSE meta', sawMeta)
  ok('SSE reasoning stream', sawReasoning, `${reasoningLen} chars (deepseek-v4-flash is a reasoning model)`)
  ok('SSE content stream', sawContent && contentLen > 10, `${contentLen} chars in ${secs}s`)
  ok('SSE usage', sawUsage)
  ok('SSE auto title', sawTitle)
  ok('SSE done', sawDone)
}

// 4. messages persisted
{
  const r = await j('GET', `/api/conversations/${convId}/messages`)
  const msgs = r.json?.messages || []
  ok('messages persisted', msgs.length >= 2, `${msgs.length} msgs`)
  const assistant = msgs.find((m) => m.role === 'assistant')
  ok('assistant has reasoning', !!assistant?.reasoning)
  ok('assistant has tokens', (assistant?.tokensIn || 0) > 0)
}

// 5. regenerate
{
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, text: '' }),
  })
  ok('regenerate (empty text) 200', res.status === 200)
  // drain
  const reader = res.body.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
  const r = await j('GET', `/api/conversations/${convId}/messages`)
  const users = (r.json?.messages || []).filter((m) => m.role === 'user').length
  const assists = (r.json?.messages || []).filter((m) => m.role === 'assistant').length
  ok('regenerate truncation', assists <= users, `users=${users} assistants=${assists}`)
}

// 6. gears
{
  const g0 = await j('GET', '/api/gear')
  ok('GET /api/gear', g0.json?.gears?.length === 5, `current=${g0.json?.gear} tick=${g0.json?.appliedTickMs}`)
  const sw = await j('PUT', '/api/gear', { gear: 'turbo' })
  ok('PUT gear turbo', sw.json?.gear === 'turbo' && sw.json?.appliedTickMs === 15000, `tick=${sw.json?.appliedTickMs}`)
  const back = await j('PUT', '/api/gear', { gear: 'balanced' })
  ok('PUT gear back', back.json?.gear === 'balanced' && back.json?.appliedTickMs === 60000)
}

// 7. models + usage
{
  const m = await j('GET', '/api/models')
  ok('GET /api/models', Array.isArray(m.json?.models) && m.json.models.length > 0, m.json?.models?.join(','))
  const u = await j('GET', '/api/usage?days=7')
  ok('GET /api/usage', Array.isArray(u.json?.usage), `${u.json?.usage?.length ?? 0} days`)
}

// 8. cleanup
{
  const r = await j('DELETE', `/api/conversations/${convId}`)
  ok('DELETE conversation', r.status === 200)
}

console.log(`\n${passed} passed · ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
