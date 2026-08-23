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
let statsDemo = false // armed by POST /api/stats?demo=1 (e2e scenario 21)
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

/* ── mutable task board (seedTasks hoists; POST/PUT /api/task mutate it
 *  and broadcast, mirroring the core API the desktop UI talks to) ── */
const tasks = seedTasks()

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

  // diagnostics: how many WS clients does the mock see right now
  if (p === '/mock/ws-info' && req.method === 'GET') {
    send(200, { clients: clients.size })
    return
  }

  // resilience hook: kick every WS client AND refuse new upgrades for a
  // short window — the badge's reconnecting state is ms-flashy against a
  // local server, so the outage needs a floor to be assertable.
  if (p === '/mock/ws-drop' && req.method === 'POST') {
    void readBody().then((b) => {
      wsDropUntil = Date.now() + Number(b.ms ?? 2500)
      const n = [...clients].filter((c) => c.readyState === 1).length
      for (const c of clients) c.terminate()
      send(200, { ok: true, dropped: n, ms: Number(b.ms ?? 2500) })
    })
    return
  }

  if (p === '/api/state') {
    send(200, {
      now: Date.now(),
      tasks,
      budget: { mode: 'burn', dailyTokens: 2_000_000, spentToday: 12345, line: 'burn · 12,345 tok' },
      mode: 'observe',
      mission: '# MISSION\nmock mission',
      rubric: '# RUBRIC\nmock rubric',
      memory: '# MEMORY\nmock memory',
      chat: [],
      version: '0.0.0-mock',
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
      // tool-frame rehearsal (grounding loop contract): the mock emits one
      // running+done chip pair when the user text mentions a tool query, so
      // e2e can pin the chat tool-chip rendering without a real backend
      if (/显卡|磁盘|工具|查/.test(String(b.text || ''))) {
        await sleep(streamDelay)
        sse({ type: 'tool', name: 'terminal', args: '{"command":"nvidia-smi"}', state: 'running' })
        await sleep(3 * streamDelay)
        sse({ type: 'tool', name: 'terminal', state: 'done', preview: 'NVIDIA GeForce RTX 4060 Ti' })
      }
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
    send(200, { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-1***cdef', patrolModel: 'deepseek-v4-flash', decideModel: 'deepseek-v4-flash', budgetMode: 'burn', dailyTokens: 2000000, tickMs: 60000, takeoverUrl: 'ws://127.0.0.1:7600', apiPort: 7620, apiHost: '127.0.0.1', thinking: false })
    return
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    send(200, { ok: true, note: 'saved (mock)' })
    return
  }
  // R31 track-record bar: empty ledger by default; POST /api/stats?demo=1
  // arms one populated entry so the e2e can see the bar render
  if (p === '/api/stats' && req.method === 'GET') {
    send(200, { agents: statsDemo ? [{ framework: 'hermes', total: 6, pass: 4, partial: 1, fail: 1, passRate: 67, recent: ['整理下载文件夹'] }] : [] })
    return
  }
  if (p === '/api/stats' && req.method === 'POST') {
    statsDemo = true
    send(200, { ok: true })
    return
  }

  if (p === '/api/task' && req.method === 'POST') {
    void readBody().then((b) => {
      const title = typeof b.title === 'string' ? b.title.trim() : ''
      if (!title || title.length > 200) return send(400, { error: 'title must be a non-empty string of at most 200 bytes' })
      tasks.push({
        id: `t${tasks.length + 1}-${Date.now()}`, title, status: 'todo', resultSummary: '',
        createdAt: Date.now(), parentId: typeof b.parentId === 'string' ? b.parentId : null,
        scheduledAt: typeof b.scheduledAt === 'number' ? b.scheduledAt : null,
        dueAt: typeof b.dueAt === 'number' ? b.dueAt : null,
        priority: 0, assignee: '', attempts: 0, overdueNaggedAt: null, acceptance: '', progress: 0, verdict: 'unchecked',
      })
      broadcast({ t: 'tasks', tasks: JSON.parse(JSON.stringify(tasks)) })
      send(202, { ok: true })
    })
    return
  }
  if (p === '/api/task' && req.method === 'PUT') {
    void readBody().then((b) => {
      const hit = tasks.find((t) => t.id === b.id)
      if (!hit) return send(404, { error: 'no such task' })
      if (b.status === 'done') {
        // mirrors ceo-core: only never-dispatched todo cards may be settled by the operator
        if (hit.status === 'done' || hit.status === 'cancelled') return send(409, { error: `task is ${hit.status} — history is immutable` })
        if (hit.status !== 'todo' || hit.assignee !== '') return send(409, { error: 'only never-dispatched todo cards can be marked done' })
        hit.status = 'done'
        hit.progress = 100
        hit.resultSummary = [hit.resultSummary, '[done by operator]'].filter(Boolean).join(' | ')
        broadcast({ t: 'tasks', tasks: JSON.parse(JSON.stringify(tasks)) })
        return send(202, { ok: true, task: hit })
      }
      if (hit.status === 'done') return send(409, { error: 'task is done — history is immutable' })
      if (hit.status !== 'cancelled') {
        hit.status = 'cancelled'
        broadcast({ t: 'tasks', tasks: JSON.parse(JSON.stringify(tasks)) })
      }
      send(202, { ok: true, task: hit })
    })
    return
  }

  // operator card edit (agenda PATCH): times epoch ms or null, title rename
  if (p === '/api/task' && req.method === 'PATCH') {
    void readBody().then((b) => {
      const hit = tasks.find((t) => t.id === b.id)
      if (!hit) return send(404, { error: 'no such task' })
      if (hit.status === 'done' || hit.status === 'cancelled') return send(409, { error: `task is ${hit.status} — history is immutable` })
      if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200)) return send(400, { error: 'title must be a non-empty string of at most 200 bytes' })
      if (b.scheduledAt === undefined && b.dueAt === undefined && b.title === undefined) return send(400, { error: 'scheduledAt, dueAt, or title required' })
      for (const k of ['scheduledAt', 'dueAt']) {
        if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'number') return send(400, { error: `${k} must be epoch ms or null` })
      }
      if (b.scheduledAt !== undefined) hit.scheduledAt = b.scheduledAt
      if (b.dueAt !== undefined) hit.dueAt = b.dueAt
      if (b.title !== undefined) hit.title = b.title
      broadcast({ t: 'tasks', tasks: JSON.parse(JSON.stringify(tasks)) })
      send(202, { ok: true, task: hit })
    })
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
let wsDropUntil = 0 // /mock/ws-drop outage window: upgrades are refused until this ts
function broadcast(frame) {
  const data = JSON.stringify(frame)
  for (const c of clients) if (c.readyState === 1) c.send(data)
}
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url || '/', `http://${req.headers.host}`)
  if (pathname !== '/api/events' || Date.now() < wsDropUntil) {
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

/** Seeded task list, shared by /api/state and stateSnapshot(). Times are
 *  relative to "now" so time-band UIs (widget gantt, command-center strip)
 *  always have a band inside their ±1h window: t3 spans the now-line, t2
 *  sits visible-but-late at ~45min out. */
function seedTasks() {
  const now = Date.now()
  return [
    { id: 't1', title: '示例任务一', status: 'done', resultSummary: '完成', createdAt: now - 3600_000, parentId: null, scheduledAt: null, dueAt: null, progress: 100, verdict: 'pass' },
    { id: 't2', title: '示例任务二', status: 'running', resultSummary: '', createdAt: now - 1800_000, parentId: null, scheduledAt: now + 45 * 60_000, dueAt: now + 90 * 60_000, progress: 40, verdict: 'unchecked' },
    { id: 't3', title: '进行中的演示任务', status: 'todo', resultSummary: '', createdAt: now - 2400_000, parentId: null, scheduledAt: now - 30 * 60_000, dueAt: now + 30 * 60_000, progress: 10, verdict: 'unchecked' },
  ]
}

function stateSnapshot() {
  return {
    now: Date.now(),
    tasks,
    budget: { mode: 'burn', dailyTokens: 2_000_000, spentToday: 12345, line: 'burn · 12,345 tok' },
    mode: 'observe',
    mission: '# MISSION\nmock mission',
    rubric: '# RUBRIC\nmock rubric',
    memory: '# MEMORY\nmock memory',
    chat: [],
    version: '0.0.0-mock',
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
