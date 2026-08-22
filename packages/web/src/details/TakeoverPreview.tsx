// packages/web/src/details/TakeoverPreview.tsx — live screen preview from
// takeoverd (ws://host:7600). Ports the viewer logic from
// packages/viewer/index.html: mode_changed / screen_diff / screenshot_gray
// frames; the 64×36 grayscale array paints into a canvas upscaled
// nearest-neighbor. Screenshots are polled at 1 fps while mounted.

import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { fill } from '../i18n'

interface ScreenState {
  status: 'connecting' | 'live' | 'offline'
  mode: string
  hamming: number | null
  ocr: string
}

export function TakeoverPreview() {
  const { t } = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [screen, setScreen] = useState<ScreenState>({
    status: 'connecting',
    mode: 'observe',
    hamming: null,
    ocr: '',
  })
  const modeRef = useRef('observe')
  const hammingRef = useRef<number | null>(null)

  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let reconnect: number | undefined
    let poll: number | undefined

    const requestFrame = (): void => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'ctrl', op: 'screenshot' }))
      }
    }

    const paint = (w: number, h: number, data: number[]): void => {
      const canvas = canvasRef.current
      if (!canvas || w <= 0 || h <= 0) return
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const img = ctx.createImageData(w, h)
      for (let i = 0; i < w * h; i++) {
        const v = Math.max(0, Math.min(255, data[i] ?? 0))
        const j = i * 4
        img.data[j] = v
        img.data[j + 1] = v
        img.data[j + 2] = v
        img.data[j + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
    }

    const connect = (): void => {
      if (stopped) return
      setScreen((s) => ({ ...s, status: ws === null && s.status === 'live' ? 'offline' : 'connecting' }))
      try {
        ws = new WebSocket(`ws://${window.location.hostname}:7600`)
      } catch {
        reconnect = window.setTimeout(connect, 2000)
        return
      }
      ws.onopen = () => {
        if (stopped) return
        setScreen((s) => ({ ...s, status: 'live', mode: modeRef.current }))
        requestFrame()
        poll = window.setInterval(requestFrame, 1000)
      }
      ws.onmessage = (ev: MessageEvent) => {
        if (stopped || typeof ev.data !== 'string') return
        let m: {
          t?: string
          type?: string
          mode?: string
          hamming?: number
          ocrText?: string
          w?: number
          h?: number
          data?: number[]
        }
        try {
          m = JSON.parse(ev.data)
        } catch {
          return
        }
        if (m.t !== 'evt') return
        if (m.type === 'mode_changed' && m.mode) {
          modeRef.current = m.mode
          setScreen((s) => ({ ...s, mode: m.mode! }))
        } else if (m.type === 'screen_diff') {
          hammingRef.current = m.hamming ?? null
          if (m.ocrText) setScreen((s) => ({ ...s, hamming: hammingRef.current, ocr: m.ocrText! }))
          else setScreen((s) => ({ ...s, hamming: hammingRef.current }))
        } else if (m.type === 'screenshot_gray' && m.data) {
          paint(m.w ?? 64, m.h ?? 36, m.data)
        }
      }
      ws.onclose = () => {
        ws = null
        if (poll !== undefined) window.clearInterval(poll)
        poll = undefined
        if (!stopped) {
          setScreen((s) => ({ ...s, status: 'offline' }))
          reconnect = window.setTimeout(connect, 2000)
        }
      }
      ws.onerror = () => {
        ws?.close()
      }
    }

    connect()
    return () => {
      stopped = true
      if (reconnect !== undefined) window.clearTimeout(reconnect)
      if (poll !== undefined) window.clearInterval(poll)
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    }
  }, [])

  return (
    <div>
      <div className="file-label">Screen · ws://{window.location.hostname}:7600</div>
      <div className="screen-wrap">
        {screen.status === 'live' ? (
          <canvas ref={canvasRef} width={64} height={36} />
        ) : (
          <div className="screen-off">takeoverd {t(`scr.${screen.status}`)}…</div>
        )}
        <span className="mode-badge">{screen.mode}</span>
      </div>
      <div className="screen-meta" style={{ marginTop: 8 }}>
        <span>{fill(t('scr.state'), { s: t(`scr.${screen.status}`) })}</span>
        {screen.hamming !== null ? <span>hamming: {screen.hamming}</span> : null}
        <span>{t('scr.fps')}</span>
      </div>
      {screen.ocr ? (
        <>
          <div className="file-label" style={{ marginTop: 12 }}>
            OCR
          </div>
          <pre className="screen-ocr">{screen.ocr}</pre>
        </>
      ) : null}
    </div>
  )
}
