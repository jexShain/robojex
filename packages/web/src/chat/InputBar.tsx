// packages/web/src/chat/InputBar.tsx — auto-growing textarea (≤8 rows) with
// IME-safe Enter-to-send, Shift+Enter newline, ↑/↓ input history, Esc clear,
// and the slash command palette. Locked from send until the next jex chat_out
// or a 30s timeout (store-managed).

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../state/store'
import { filterSlash, SlashMenu } from './SlashMenu'
import type { SlashEntry } from './SlashMenu'

const MAX_HEIGHT = 176 // 8 lines at 1.55 × 14.5px

export function InputBar() {
  const { state, sendChat, runCommand } = useStore()
  const [value, setValue] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [selIdx, setSelIdx] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const history = useRef<string[]>([])
  const histIdx = useRef(-1)
  const draft = useRef('')

  const trimmed = value.trim()
  const menuOpen =
    !dismissed && value.startsWith('/') && !value.includes('\n') && value.length <= 40
  const entries = menuOpen ? filterSlash(value) : []
  const activeIdx = Math.min(selIdx, Math.max(0, entries.length - 1))

  // Auto-grow: shrink to content, then clamp to the 8-row ceiling.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  // Return focus (and the caret) once the reply lock releases.
  useEffect(() => {
    if (!state.waiting && state.transcript.length > 0) taRef.current?.focus()
  }, [state.waiting, state.transcript.length])

  const resetInput = (): void => {
    setValue('')
    setDismissed(false)
    setSelIdx(0)
    histIdx.current = -1
  }

  const submit = (raw: string): void => {
    const text = raw.trim()
    if (!text || state.waiting) return
    history.current.push(text)
    resetInput()
    if (!runCommand(text)) sendChat(text)
  }

  /** Enter/Tab with the palette open: selected entry, plus any typed argument. */
  const submitSelected = (): void => {
    const entry = entries[activeIdx]
    if (!entry) return
    const base = entry.label.split(' ')[0]!
    const arg = value.trim().slice(base.length).trim()
    submit(arg ? `${base} ${arg}` : entry.label.replace(/ <text>$/, ''))
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // IME composing: Enter confirms the composition, never submits.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (menuOpen && entries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelIdx((activeIdx + 1) % entries.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelIdx((activeIdx - 1 + entries.length) % entries.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        submitSelected()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit(value)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      resetInput()
      return
    }
    if (e.key === 'ArrowUp' && (histIdx.current !== -1 || value === '')) {
      e.preventDefault()
      const h = history.current
      if (h.length === 0) return
      if (histIdx.current === -1) {
        draft.current = value
        histIdx.current = 0
      } else if (histIdx.current < h.length - 1) {
        histIdx.current += 1
      }
      setValue(h[h.length - 1 - histIdx.current]!)
      return
    }
    if (e.key === 'ArrowDown' && histIdx.current !== -1) {
      e.preventDefault()
      const h = history.current
      histIdx.current -= 1
      setValue(histIdx.current === -1 ? draft.current : h[h.length - 1 - histIdx.current]!)
    }
  }

  const onChange = (v: string): void => {
    setValue(v)
    setDismissed(false)
    setSelIdx(0)
    histIdx.current = -1 // manual edits leave history navigation
  }
  const onPickEntry = (entry: SlashEntry): void => {
    const base = entry.label.split(' ')[0]!
    const arg = value.trim().slice(base.length).trim()
    submit(arg ? `${base} ${arg}` : entry.label.replace(/ <text>$/, ''))
  }

  return (
    <div className="inputbar">
      <div className={`input-shell${state.waiting ? ' disabled' : ''}`}>
        {menuOpen ? (
          <SlashMenu
            entries={entries}
            activeIdx={activeIdx}
            onHover={setSelIdx}
            onPick={onPickEntry}
          />
        ) : null}
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          disabled={state.waiting}
          placeholder={
            state.waiting ? 'jex is thinking…' : 'Message jex — / for commands'
          }
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="input-foot">
          <span className="input-hint">
            Enter to send · Shift+Enter newline · ↑ history · / commands
          </span>
          <button
            type="button"
            className="send-btn"
            title="Send"
            aria-label="Send message"
            disabled={state.waiting || trimmed.length === 0}
            onClick={() => submit(value)}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M14 2 7.5 8.5M14 2l-4.4 12L7.5 8.5 2 6.6 14 2Z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
