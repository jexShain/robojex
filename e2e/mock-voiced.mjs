// e2e/mock-voiced.mjs — in-memory stand-in for the local voice daemon
// (packages/voiced, :7640 in real life). The renderer's voice reporting
// (state/voice.ts) fetches VOICED_URL/tts cross-origin, so CORS headers are
// part of the contract under test. /hits lets scenarios assert WHAT was
// spoken without any real audio stack: every /tts POST is recorded with its
// text, and a tiny valid wav comes back (speak() rejects bodies < 44 bytes).

import http from 'node:http'

const PORT = Number(process.env.VOICED_MOCK_PORT || 7690)
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

/** @type {{ tts: Array<{text: string, sid: number}>, asr: number }} */
const hits = { tts: [], asr: 0 }

/** minimal valid mono 16k 16-bit PCM wav of `seconds` silence */
function silenceWav(seconds = 0.2) {
  const n = Math.floor(16000 * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  return b
}
const WAV = silenceWav()

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }
  const json = (code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
  }
  if (url.pathname === '/health' && req.method === 'GET') {
    return json(200, { asr: 'sensevoice', tts: 'kokoro', hint: '' })
  }
  if (url.pathname === '/hits' && req.method === 'GET') {
    return json(200, hits)
  }
  if (url.pathname === '/tts' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let q = {}
      try { q = JSON.parse(body) } catch { /* recorded as empty */ }
      hits.tts.push({ text: String(q.text ?? ''), sid: Number(q.sid ?? 0) })
      res.writeHead(200, { ...CORS, 'content-type': 'audio/wav', 'content-length': WAV.length })
      res.end(WAV)
    })
    return
  }
  if (url.pathname === '/asr' && req.method === 'POST') {
    hits.asr += 1
    return json(200, { text: '模拟语音输入' })
  }
  return json(404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-voiced] http://127.0.0.1:${PORT}  (tts stub + /hits)`)
})
