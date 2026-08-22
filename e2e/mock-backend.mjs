// e2e/mock-backend.mjs — in-memory stand-in for ceo-core's ApiServer,
// implementing the desktop contract (see packages/web/src/state/types.ts):
// REST conversations + SSE streaming chat + gears + WS /api/events.
// Serves the built web bundle from packages/web/dist when present, so the
// Playwright run needs no real backend or API key.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.MOCK_PORT || 7620)
const HOST = '127.0.0.1'
const WEB_DIR = process.env.MOCK_WEB_DIR || path.resolve('packages/web/dist')

const uid = () => crypto.randomUUID()

/* ── gears (mirrors ceo-core gears.ts / web types.ts) ── */
const GEARS = [
  { id: 'dormant', level: 0, name: '休眠', emoji: '😴', tickMs: 0, decideMaxTokens: 0, patrolEvery: 0, desc: 'jex 沉睡，只响应直聊', cost: '零消耗' },
  { id: 'eco', level: 1, name: '省电', emoji: '🌿', tickMs: 300000, decideMaxTokens: 2048, patrolEvery: 5, desc: '只关注关键事件，动作保守', cost: '极省 token' },
  { id: 'balanced', level: 2, name: '均衡', emoji: '⚖️', tickMs: 60000, decideMaxTokens: 4096, patrolEvery: 1, desc: '正常自主，平衡成本', cost: '标准' },
  { id: 'focused', level: 3, name: '专注', emoji: '🎯', tickMs: 30000, decideMaxTokens: 8192, patrolEvery: 1, desc: '主动推进任务板', cost: '较高' },
  { id: 'turbo', level: 4, name: '狂暴', emoji: '🚀', tickMs: 15000, decideMaxTokens: 16384, patrolEvery: 1, desc: '最大自主，自我发起与审计', cost: '全速燃烧' },
]
let gearNow = 'balanced'

/* ── conversations store ── */
/** @type {Map<string, any>} */
const convs = new Map()
/** @type {Map<string, any[]>} convId -> messages */
const msgs = new Map()

function seed() {
  const mk = (title, agoMin, pinned) => {
    const id = uid()
    const t = Date.now() - agoMin * 60_000
    convs.set(id, { id, title, createdAt: t, updatedAt: t, pinned: pinned ? 1 : 0, gear: 'balanced', model: 'deepseek-v4-flash', archived: 0, messageCount: 2 })
    msgs.set(id, [
      { id: uid(), convId: id, role: 'user', content: '你好，介绍下你自己', createdAt: t },
      { id: uid(), convId: id, role: 'assistant', content: `我是 **RoboJex**（${title}）。\n\n\`\`\`ts\nconst jex = 'ready'\n\`\`\``, reasoning: '用户问候，简单介绍。', model: 'deepseek-v4-flash', tokensIn: 12, tokensOut: 34, createdAt: t + 1000 },
    ])
    return id
  }
  mk('置顶的会话', 90, true)
  mk('今天的会话', 30, false)
  mk('昨天的会话', 60 * 26, false)
  mk('更早的会话', 60 * 24 * 9, false)
}
seed()

function convView(c) {
  const list = msgs.get(c.id) || []
  const last = list[list.length - 1]
  return { ...c, messageCount: list.length, preview: (last?.content || '').slice(0, 80) }
}

/* ── SSE stream control ── */
let streamDelay = 120 // ms between deltas; tests can slow it via /mock/slow
const activeStreams = new Set()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── server ── */
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const p = url.pathname
  const send = (code, body) => {
    const json = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(json)
  }
  const readBody = () =>
    new Promise((resolve) => {
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => {
        try {
          resolve(buf ? JSON.parse(buf) : {})
        } catch {
          resolve({})
        }
      })
    })

  // test hooks
  if (p === '/mock/slow' && req.method === 'POST') {
    void readBody().then((b) => {
      streamDelay = Number(b.delay ?? 120)
      send(200, { ok: true, delay: streamDelay })
    })
    return
  }

  if (p === '/api/state') {
    send(200, {
      now: Date.now(),
      tasks: [
        { id: 't1', title: '示例任务一', status: 'done', resultSummary: '完成', createdAt: Date.now() - 3600_000, parentId: null, scheduledAt: null, dueAt: null, progress: 100, verdict: 'pass' },
        { id: 't2', title: '示例任务二', status: 'running', resultSummary: '', createdAt: Date.now() - 1800_000, parentId: null, scheduledAt: Date.now() + 3600_000, dueAt: Date.now() + 7200_000, progress: 40, verdict: 'unchecked' },
      ],
      budget: { mode: 'burn', dailyTokens: 2_000_000, spentToday: 12345, line: 'burn · 12,345 tok' },
      mode: 'observe',
      mission: '# MISSION\nmock mission',
      rubric: '# RUBRIC\nmock rubric',
      memory: '# MEMORY\nmock memory',
      chat: [],
      version: 'e2e-mock',
      tickN: 3,
      gear: gearNow,
    })
    return
  }

  if (p === '/api/conversations' && req.method === 'GET') {
    const list = [...convs.values()]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map(convView)
    send(200, { conversations: list })
    return
  }
  if (p === '/api/conversations' && req.method === 'POST') {
    void readBody().then((b) => {
      const id = uid()
      const now = Date.now()
      const conv = { id, title: b.title || '新对话', createdAt: now, updatedAt: now, pinned: 0, gear: gearNow, model: 'deepseek-v4-flash', archived: 0 }
      convs.set(id, conv)
      msgs.set(id, [])
      send(201, convView(conv))
    })
    return
  }
  const convMatch = /^\/api\/conversations\/([^/]+)$/.exec(p)
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1])
    if (req.method === 'PATCH') {
      void readBody().then((b) => {
        const c = convs.get(id)
        if (!c) return send(404, { error: 'not found' })
        if (typeof b.title === 'string') c.title = b.title
        if (typeof b.pinned === 'boolean') c.pinned = b.pinned ? 1 : 0
        if (typeof b.archived === 'boolean') c.archived = b.archived ? 1 : 0
        send(200, convView(c))
      })
      return
    }
    if (req.method === 'DELETE') {
      convs.delete(id)
      msgs.delete(id)
      send(200, { ok: true })
      return
    }
  }
  const msgListMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(p)
  if (msgListMatch && req.method === 'GET') {
    const id = decodeURIComponent(msgListMatch[1])
    send(200, { messages: msgs.get(id) || [] })
    return
  }
  if (p === '/api/messages' || p.startsWith('/api/messages/')) {
    // DELETE /api/messages/:id
    const id = p.split('/')[3]
    if (req.method === 'DELETE' && id) {
      for (const list of msgs.values()) {
        const i = list.findIndex((m) => m.id === id)
        if (i >= 0) {
          list.splice(i, 1)
          break
        }
      }
      send(200, { ok: true })
      return
    }
  }

  if (p === '/api/chat/stream' && req.method === 'POST') {
    void readBody().then(async (b) => {
      const convId = b.conversationId
      const conv = convs.get(convId)
      if (!conv) return send(404, { error: 'conversation not found' })
      const list = msgs.get(convId)

      let userMsgId = ''
      if (typeof b.text === 'string' && b.text.length > 0) {
        userMsgId = uid()
        list.push({ id: userMsgId, convId, role: 'user', content: b.text, createdAt: Date.now() })
      } else {
        // regenerate: truncate after last user message
        while (list.length && list[list.length - 1].role !== 'user') list.pop()
      }

      const assistantMsgId = uid()
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const sse = (obj) => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      let aborted = false
      const onAbort = () => {
        aborted = true
      }
      req.on('close', onAbort)
      activeStreams.add(onAbort)

      const userText = b.text || '重新生成'
      sse({ type: 'meta', conversationId: convId, userMsgId, assistantMsgId, model: b.model || 'deepseek-v4-flash' })
      await sleep(streamDelay)
      // reasoning phase
      const reasoningChunks = [`用户说「${userText.slice(0, 12)}」`, '，思考如何回答', '：组织语言，给出示例。']
      for (const chunk of reasoningChunks) {
        if (aborted) break
        sse({ type: 'reasoning', delta: chunk })
        await sleep(streamDelay)
      }
      // content phase — includes markdown fixtures
      const contentChunks = [
        '好的！这是一段 **Markdown** 回答：\n\n',
        '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n',
        '```python\nprint("hello robojex")\n```\n\n',
        '> 引用一句\n\n',
        '回答完毕 ✅',
      ]
      for (const chunk of contentChunks) {
        if (aborted) break
        sse({ type: 'content', delta: chunk })
        await sleep(streamDelay)
      }
      sse({ type: 'usage', tokensIn: 88, tokensOut: 234 })
      const hadAssistant = list.some((m) => m.role === 'assistant')
      if (!hadAssistant || userText.includes('标题')) {
        const title = `会话·${userText.slice(0, 6) || '重新生成'}`
        conv.title = title
        sse({ type: 'title', title })
      }
      if (!aborted) {
        list.push({ id: assistantMsgId, convId, role: 'assistant', content: contentChunks.join(''), reasoning: reasoningChunks.join(''), model: 'deepseek-v4-flash', tokensIn: 88, tokensOut: 234, createdAt: Date.now() })
        conv.updatedAt = Date.now()
      }
      sse({ type: 'done' })
      res.end()
      activeStreams.delete(onAbort)
    })
    return
  }

  if (p === '/api/chat/stop' && req.method === 'POST') {
    for (const abort of activeStreams) abort()
    activeStreams.clear()
    send(200, { ok: true })
    return
  }

  if (p === '/api/gear' && req.method === 'GET') {
    const g = GEARS.find((x) => x.id === gearNow)
    send(200, { gear: gearNow, gears: GEARS, appliedTickMs: g.tickMs })
    return
  }
  if (p === '/api/gear' && req.method === 'PUT') {
    void readBody().then((b) => {
      if (!GEARS.some((g) => g.id === b.gear)) return send(400, { error: 'bad gear' })
      gearNow = b.gear
      broadcast({ t: 'gear', gear: gearNow })
      const g = GEARS.find((x) => x.id === gearNow)
      send(200, { gear: gearNow, gears: GEARS, appliedTickMs: g.tickMs })
    })
    return
  }

  if (p === '/api/models') {
    send(200, { models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'] })
    return
  }
  if (p === '/api/usage') {
    const usage = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000)
      usage.push({ day: d.toISOString().slice(0, 10), tokensIn: 1000 * (7 - i), tokensOut: 2000 * (7 - i), calls: 7 - i })
    }
    send(200, { usage })
    return
  }
  if (p === '/api/settings' && req.method === 'GET') {
    send(200, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1***cdef', patrolModel: 'deepseek-v4-flash', decideModel: 'deepseek-v4-flash', budgetMode: 'burn', dailyTokens: 2000000, tickMs: 60000, takeoverUrl: 'ws://127.0.0.1:7600', apiPort: 7620, apiHost: '127.0.0.1' })
    return
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    send(200, { ok: true, note: 'saved (mock)' })
    return
  }

  if (p.startsWith('/api/')) return send(404, { error: 'not found' })

  // static web bundle (SPA fallback)
  if (!fs.existsSync(WEB_DIR)) {
    res.writeHead(500)
    res.end('web dist missing — run vite build first')
    return
  }
  let file = path.join(WEB_DIR, p === '/' ? 'index.html' : p)
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(WEB_DIR, 'index.html')
  }
  const ext = path.extname(file)
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
const clients = new Set()
function broadcast(frame) {
  const data = JSON.stringify(frame)
  for (const c of clients) if (c.readyState === 1) c.send(data)
}
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', `http://${req.headers.host}`)
  if (pathname !== '/api/events') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
    ws.send(JSON.stringify({ t: 'hello', state: JSON.parse(JSON.stringify(stateSnapshot())) }))
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw))
        if (m.t === 'chat') broadcast({ t: 'chat_out', from: 'jex', text: `[mock jex] 收到编排指令：${m.text}`, ts: Date.now() })
      } catch {
        // ignore
      }
    })
  })
})

function stateSnapshot() {
  return {
    now: Date.now(),
    tasks: [
      { id: 't1', title: '示例任务一', status: 'done', resultSummary: '完成', createdAt: Date.now() - 3600_000, parentId: null, scheduledAt: null, dueAt: null, progress: 100, verdict: 'pass' },
      { id: 't2', title: '示例任务二', status: 'running', resultSummary: '', createdAt: Date.now() - 1800_000, parentId: null, scheduledAt: Date.now() + 3600_000, dueAt: Date.now() + 7200_000, progress: 40, verdict: 'unchecked' },
    ],
    budget: { mode: 'burn', dailyTokens: 2_000_000, spentToday: 12345, line: 'burn · 12,345 tok' },
    mode: 'observe',
    mission: '# MISSION\nmock mission',
    rubric: '# RUBRIC\nmock rubric',
    memory: '# MEMORY\nmock memory',
    chat: [],
    version: 'e2e-mock',
    tickN: 3,
    gear: gearNow,
  }
}

// gentle lifecycle frames so HUD/handshake widgets have data
setInterval(() => {
  broadcast({ t: 'budget', line: 'burn · mock ticking' })
}, 30_000)

server.listen(PORT, HOST, () => {
  console.log(`[mock-backend] http/ws on http://${HOST}:${PORT} · web=${WEB_DIR}`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
