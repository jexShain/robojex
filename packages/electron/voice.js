// packages/electron/voice.js — voice pill page logic (loaded by voice.html).
// External file (not inline) so the packaged app's CSP `script-src 'self'`
// admits it; inline <script> tags would be blocked in prod.
/* global window, document, navigator, AudioContext */
(function () {
  'use strict'

  const $text = document.getElementById('text')
  const $hint = document.getElementById('hint')
  const $dot = document.getElementById('dot')

  function setState(text, opts) {
    $text.textContent = text
    $dot.className = 'dot' + (opts && opts.dot ? ' ' + opts.dot : '')
    if (opts && opts.hint) {
      $hint.hidden = false
      $hint.textContent = opts.hint
    } else {
      $hint.hidden = true
    }
  }

  /* ---- capture (started/stopped by main via voice:state) ---- */
  let ctx = null
  let stream = null
  let node = null
  let chunks = null
  let sampleRate = 16000
  let recording = false

  async function startCapture() {
    if (recording) return
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      })
    } catch (e) {
      setState('麦克风不可用', { dot: 'idle', hint: String((e && e.message) || e) })
      if (window.robojex && window.robojex.voice) window.robojex.voice.event('mic-denied')
      return
    }
    ctx = new AudioContext({ sampleRate: 16000 })
    sampleRate = ctx.sampleRate
    const src = ctx.createMediaStreamSource(stream)
    node = ctx.createScriptProcessor(4096, 1, 1)
    chunks = []
    node.onaudioprocess = function (ev) {
      if (recording) chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)))
    }
    src.connect(node)
    node.connect(ctx.destination) // ScriptProcessor needs a destination to run
    recording = true
    setState('正在聆听…再按一次结束', { dot: '' })
  }

  async function stopCapture() {
    if (!recording) return
    recording = false
    const frames = chunks || []
    chunks = null
    try { if (node) node.disconnect() } catch (e) { /* closing anyway */ }
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop() }) } catch (e) { /* ditto */ }
    try { if (ctx) ctx.close() } catch (e) { /* ditto */ }
    node = null
    stream = null
    ctx = null
    let n = 0
    for (const f of frames) n += f.length
    if (n < 1600) {
      // <0.1s: accidental tap, not speech
      setState('太短，已忽略', { dot: 'idle' })
      if (window.robojex && window.robojex.voice) window.robojex.voice.event('too-short')
      return
    }
    const merged = new Float32Array(n)
    let off = 0
    for (const f of frames) {
      merged.set(f, off)
      off += f.length
    }
    setState('转写中…', { dot: 'idle' })
    if (window.robojex && window.robojex.voice) window.robojex.voice.sendClip(pcmWav(merged, sampleRate).buffer)
  }

  /** mono Float32 → 16-bit PCM WAV ArrayBuffer */
  function pcmWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2)
    const v = new DataView(buf)
    const ws = function (o, s) {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
    }
    ws(0, 'RIFF')
    v.setUint32(4, 36 + samples.length * 2, true)
    ws(8, 'WAVE')
    ws(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, rate, true)
    v.setUint32(28, rate * 2, true)
    v.setUint16(32, 2, true)
    v.setUint16(34, 16, true)
    ws(36, 'data')
    v.setUint32(40, samples.length * 2, true)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      v.setInt16(44 + i * 2, Math.round(s * 32767), true)
    }
    return buf
  }

  /* ---- main-driven state ---- */
  if (window.robojex && window.robojex.voice && window.robojex.voice.onState) {
    window.robojex.voice.onState(function (st) {
      if (st === 'start') void startCapture()
      else if (st === 'stop') void stopCapture()
      else if (st === 'sent') setState('已发送 ✓', { dot: 'ok' })
      else if (st === 'empty') setState('没听清，请再试', { dot: 'idle' })
      else if (st === 'err') setState('语音服务异常', { dot: 'idle', hint: 'voiced :7640 未就绪' })
    })
  }
})()
