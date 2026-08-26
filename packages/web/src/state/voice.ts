// packages/web/src/state/voice.ts — renderer-side voice reporting (SPEC-VOICE).
// The local voiced daemon (:7640) already served the push-to-talk pill via the
// Electron main process; this module is the OTHER direction — speaking jex
// replies/briefings aloud from the renderer. One Audio element at a time: a
// new speak() cancels the previous playback so a burst of briefings never
// stacks audio. localStorage-backed like the notify pref; never throws —
// voice is a convenience layer and must not be able to break the UI.

const VOICE_REPORT_KEY = 'robojex-voice-report'
const VOICED_URL_KEY = 'robojex-voiced-url'
const DEFAULT_VOICED_URL = 'http://127.0.0.1:7640'

/** Cap what we hand to Kokoro: CPU synthesis of ~800 chars is a few seconds,
 *  enough for any sane briefing without freezing the daemon on a paste. */
const SPEAK_MAX = 800

export function voicedUrl(): string {
  try {
    return window.localStorage.getItem(VOICED_URL_KEY) || DEFAULT_VOICED_URL
  } catch {
    return DEFAULT_VOICED_URL
  }
}

/** 语音汇报 pref: jex replies + briefings are spoken aloud when '1'. */
export function readVoiceReport(): boolean {
  try {
    return window.localStorage.getItem(VOICE_REPORT_KEY) === '1'
  } catch {
    return false
  }
}

export function writeVoiceReport(on: boolean): void {
  try {
    window.localStorage.setItem(VOICE_REPORT_KEY, on ? '1' : '0')
  } catch {
    // best-effort only
  }
}

let currentAudio: HTMLAudioElement | null = null
let currentUrl = ''

/** Stop any in-flight playback (settings toggle off, app teardown). */
export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.onended = null
    if (currentUrl) URL.revokeObjectURL(currentUrl)
    currentAudio = null
    currentUrl = ''
  }
}

/** Speak `text` through voiced POST /tts and play the returned wav. */
export async function speak(text: string): Promise<void> {
  const body = text.replace(/\s+/g, ' ').trim().slice(0, SPEAK_MAX)
  if (!body || typeof window === 'undefined' || typeof fetch === 'undefined') return
  let url = ''
  let audio: HTMLAudioElement | null = null
  try {
    const res = await fetch(`${voicedUrl()}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: body, sid: 0 }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`/tts ${res.status}`)
    const blob = await res.blob()
    if (blob.size < 44) throw new Error('tts returned no audio')
    stopSpeaking() // supersede the previous playback (its URL is revoked there)
    url = URL.createObjectURL(blob)
    audio = new Audio(url)
    currentAudio = audio
    currentUrl = url
    audio.onended = () => {
      if (currentAudio === audio) { currentAudio = null; currentUrl = '' }
      URL.revokeObjectURL(url)
    }
    audio.onerror = () => {
      // 'error' never fires 'ended': without this the blob URL leaks too
      if (currentAudio === audio) { currentAudio = null; currentUrl = '' }
      URL.revokeObjectURL(url)
    }
    await audio.play()
  } catch (err) {
    // play() rejected (autoplay blocked) or the fetch failed: an Audio that
    // never started must not hold its multi-MB blob URL forever
    if (audio && currentAudio === audio) {
      currentAudio = null
      currentUrl = ''
    }
    if (url) URL.revokeObjectURL(url)
    // daemon down / autoplay blocked — surfaced only in the console
    console.warn('[voice] speak unavailable:', err instanceof Error ? err.message : err)
  }
}

