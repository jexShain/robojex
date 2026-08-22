// packages/web/src/chat/InputBar.tsx — floating bottom input card: auto-height
// textarea (1→10 rows), IME-safe Enter send, Shift+Enter newline, ↑/↓ history
// (single line only), slash palette, @ gear mentions, gear + model chip
// popovers, char/token estimate, stop/send swap while streaming. `/`-prefixed
// text routes to runCommand; `@<gear>` tokens apply the gear on send.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { GearId } from '../state/types'
import { gearsOrFallback, localizeGears } from '../views/gearDefs'
import { filterSlash, SlashMenu } from './SlashMenu'
import type { SlashEntry } from './SlashMenu'
import { extractGearTokens, trailingMention } from './gearTokens'
import './chat.css'

const MAX_HEIGHT = 264 // ~10 rows at 1.6 × 16.5px

/** Complete a palette pick against the typed text: finish a partial prefix
 * (typing `/gear tu` + Enter submits `/gear turbo`), keep any typed argument
 * (`/model abc` stays intact), never submit the raw partial. */
function resolvePick(label: string, typed: string): string {
  const base = label.replace(/ <[^>]*>$/, '').split(' ')[0]!
  const completed = label.replace(/ <[^>]*>$/, '')
  if (typed !== completed && completed.startsWith(typed)) return completed
  const arg = typed.slice(base.length).trim()
  return arg ? `${base} ${arg}` : completed
}

function CheckIcon(): JSX.Element {
  return (
    <svg className="check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  )
}

export function InputBar() {
  const { state, sendMessage, stopStream, runCommand, changeGear, setModel, refreshModels } = useStore()
  const { t } = useT()
  const [value, setValue] = useState('')
  const [dismissed, setDismissed] = useState(false) // slash palette Esc-dismissed
  const [selIdx, setSelIdx] = useState(0)
  const [atDismissed, setAtDismissed] = useState(false) // @ mention menu Esc-dismissed
  const [atIdx, setAtIdx] = useState(0)
  const [gearOpen, setGearOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const history = useRef<string[]>([])
  const histIdx = useRef(-1)
  const draft = useRef('')

  // localized display table: dict names/descs/costs over live-or-fallback data
  const gears = useMemo(() => localizeGears(gearsOrFallback(state.gears), t), [state.gears, t])
  const gearDef = gears.find((g) => g.id === state.gear) ?? gears[2]!
  const streaming = state.stream.status === 'streaming' || state.stream.status === 'stopping'
  const trimmed = value.trim()

  const menuOpen =
    !dismissed && !gearOpen && !modelOpen &&
    value.startsWith('/') && !value.includes('\n') && value.length <= 44
  const entries = menuOpen ? filterSlash(value) : []
  const activeIdx = Math.min(selIdx, Math.max(0, entries.length - 1))

  /* @ gear mention menu: a `@word` being typed at the end of the value */
  const mention = trailingMention(value)
  const atOpen = !atDismissed && !menuOpen && !gearOpen && !modelOpen && mention !== null
  const typedLc = atOpen && mention ? mention.typed.toLowerCase() : ''
  const atEntries = atOpen ? gears.filter((g) => g.id.startsWith(typedLc)) : []
  const atActive = Math.min(atIdx, Math.max(0, atEntries.length - 1))

  /* char count + rough token estimate (mixed CJK/latin ≈ length / 1.6) */
  const bodyLen = value.trim().length

  /* auto-grow 1→10 rows */
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  /* close popovers on outside pointer */
  useEffect(() => {
    if (!gearOpen && !modelOpen) return
    const onDown = (e: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setGearOpen(false)
        setModelOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [gearOpen, modelOpen])

  /* model list loads lazily on first open */
  useEffect(() => {
    if (modelOpen && state.models.length === 0) void refreshModels()
  }, [modelOpen, state.models.length, refreshModels])

  /* return focus once the stream ends — never steal it from other controls */
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      const el = document.activeElement
      if (el === null || el === document.body || el === taRef.current) taRef.current?.focus()
    }
    wasStreaming.current = streaming
  }, [streaming])

  const resetInput = (): void => {
    setValue('')
    setDismissed(false)
    setSelIdx(0)
    setAtDismissed(false)
    setAtIdx(0)
    histIdx.current = -1
  }

  const submit = (raw: string): void => {
    const text = raw.trim()
    if (!text) return
    if (text.startsWith('/')) {
      // commands (gear/theme/…) stay available while a reply streams
      history.current.push(text)
      resetInput()
      runCommand(text)
      return
    }
    // @挡位提及：应用最后一个 token，并把所有 token 从发送文本剥除
    const { text: body, gear } = extractGearTokens(text)
    if (body.length === 0) {
      // 只剩挡位提及 → 一次纯挡位切换（流式中也可用）
      history.current.push(text)
      resetInput()
      if (gear) void changeGear(gear)
      return
    }
    if (streaming) return
    history.current.push(body)
    resetInput()
    if (gear) void changeGear(gear)
    void sendMessage(body)
  }

  const submitSelected = (): void => {
    const entry = entries[activeIdx]
    if (entry) submit(resolvePick(entry.label, value.trim()))
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
    if (atOpen && atEntries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtIdx((atActive + 1) % atEntries.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtIdx((atActive - 1 + atEntries.length) % atEntries.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickAtGear(atEntries[atActive]!.id)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAtDismissed(true)
        return
      }
    }
    // Enter-to-send preference (settings › chat): '0' flips the mapping —
    // plain Enter newlines, Ctrl/Cmd+Enter submits
    const enterSend = (() => {
      try { return localStorage.getItem('robojex-enter-send') !== '0' } catch { return true }
    })()
    const submitKey = enterSend
      ? (e.key === 'Enter' && !e.shiftKey)
      : (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
    if (submitKey) {
      e.preventDefault()
      submit(value)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      resetInput()
      taRef.current?.blur()
      return
    }
    const singleLine = !value.includes('\n')
    if (e.key === 'ArrowUp' && singleLine && (histIdx.current !== -1 || value === '')) {
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
    if (e.key === 'ArrowDown' && singleLine && histIdx.current !== -1) {
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
    setAtDismissed(false)
    setAtIdx(0)
    histIdx.current = -1 // manual edits leave history navigation
  }

  const onPickEntry = (entry: SlashEntry): void => {
    submit(resolvePick(entry.label, value.trim()))
  }

  /** Complete the trailing `@word` into `@<gear-id> ` in place. */
  const pickAtGear = (id: GearId): void => {
    const t = trailingMention(value)
    const at = t ? t.at : value.length
    setValue(`${value.slice(0, at)}@${id} `)
    setAtDismissed(false)
    setAtIdx(0)
  }

  const pickGear = (id: GearId): void => {
    setGearOpen(false)
    if (id !== state.gear) void changeGear(id)
  }
  const pickModel = (m: string): void => {
    setModelOpen(false)
    setModel(m)
  }

  /* chips should not lose the textarea focus on click */
  const keepFocus = (e: ReactMouseEvent): void => e.preventDefault()

  return (
    <div className="ib-wrap" ref={wrapRef}>
      {menuOpen ? (
        <SlashMenu entries={entries} activeIdx={activeIdx} onHover={setSelIdx} onPick={onPickEntry} />
      ) : null}

      {atOpen && atEntries.length > 0 ? (
        <div className="ib-at" data-testid="gear-mention" role="listbox" aria-label={t('input.atAria')}>
          <div className="ib-at-title">{t('input.atTitle')}</div>
          {atEntries.map((g, i) => (
            <button
              key={g.id}
              type="button"
              role="option"
              aria-selected={i === atActive}
              className={`ib-at-item${i === atActive ? ' active' : ''}`}
              data-testid="gear-mention-opt"
              data-gear={g.id}
              onMouseDown={(ev) => {
                // mousedown beats blur: pick before the textarea loses focus
                ev.preventDefault()
                pickAtGear(g.id)
              }}
              onMouseEnter={() => setAtIdx(i)}
            >
              <span className="dot" style={{ background: `var(--rj-gear-${g.level})` }} />
              <span className="nm">
                {g.emoji} {g.name}
              </span>
              <span className="tok">@{g.id}</span>
            </button>
          ))}
        </div>
      ) : null}

      {gearOpen ? (
        <div className="ib-pop" data-testid="gear-popover" role="listbox" aria-label={t('input.gearPopAria')}>
          <div className="ib-pop-title">{t('input.gearPopTitle')}</div>
          {gears.map((g) => (
            <button
              key={g.id}
              type="button"
              role="option"
              aria-selected={g.id === state.gear}
              className={`ib-pop-item${g.id === state.gear ? ' active' : ''}`}
              data-testid="gear-opt"
              data-gear={g.id}
              style={{ '--pop-accent': `var(--rj-gear-${g.level})` } as CSSProperties}
              onClick={() => pickGear(g.id)}
            >
              <span className="bar" />
              <span className="info">
                <span className="nm">
                  {g.emoji} {g.name}
                </span>
                <span className="ds">{g.desc}</span>
              </span>
              <span className="cost">{g.cost}</span>
              {g.id === state.gear ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {modelOpen ? (
        <div className="ib-pop right" role="listbox" aria-label={t('input.modelPopAria')}>
          <div className="ib-pop-title">{t('input.modelPopTitle')}</div>
          {state.models.length === 0 ? (
            <div className="ib-pop-empty">{t('input.modelEmpty')}</div>
          ) : (
            state.models.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === state.model}
                className={`ib-pop-item${m === state.model ? ' active' : ''}`}
                data-testid="model-opt"
                onClick={() => pickModel(m)}
              >
                <span className="info">
                  <span className="nm mono">{m}</span>
                </span>
                {m === state.model ? <CheckIcon /> : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      <div className={`ib-card${streaming ? ' streaming' : ''}`}>
        <textarea
          ref={taRef}
          rows={1}
          data-testid="chat-input"
          value={value}
          placeholder={streaming ? t('input.placeholderStreaming') : t('input.placeholder')}
          spellCheck={false}
          autoFocus
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="ib-row">
          <div className="ib-chips">
            <button
              type="button"
              className="ib-chip"
              data-testid="gear-chip"
              title={fill(t('input.gearChipTitle'), { name: gearDef.name, desc: gearDef.desc })}
              aria-label={t('input.gearChipAria')}
              aria-expanded={gearOpen}
              onMouseDown={keepFocus}
              onClick={() => {
                setModelOpen(false)
                setGearOpen((v) => !v)
              }}
            >
              <span
                className="ib-gear-dot"
                style={{ background: `var(--rj-gear-${gearDef.level})`, boxShadow: `0 0 6px var(--rj-gear-${gearDef.level})` }}
              />
              <span className="chip-label">
                {gearDef.emoji} {gearDef.name}
              </span>
              <svg className="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 10l4-4 4 4" />
              </svg>
            </button>
            <button
              type="button"
              className="ib-chip"
              data-testid="model-chip"
              title={fill(t('input.modelChipTitle'), { name: state.model })}
              aria-label={t('input.modelChipAria')}
              aria-expanded={modelOpen}
              onMouseDown={keepFocus}
              onClick={() => {
                setGearOpen(false)
                setModelOpen((v) => !v)
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="1.8" y="3" width="12.4" height="10" rx="2" />
                <path d="M5.6 6.8 4 8l1.6 1.2M10.4 6.8 12 8l-1.6 1.2M8.8 5.6 7.2 10.4" />
              </svg>
              <span className="chip-label">{state.model}</span>
              <svg className="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 10l4-4 4 4" />
              </svg>
            </button>
          </div>
          {bodyLen > 0 ? (
            <div className="ib-count" data-testid="input-count">
              {fill(t('input.count'), { n: bodyLen, m: Math.ceil(bodyLen / 1.6) })}
            </div>
          ) : null}
          <div className="ib-actions">
            {streaming ? (
              <button
                type="button"
                className="ib-stop"
                data-testid="stream-stop"
                title={t('input.stop')}
                aria-label={t('input.stop')}
                onClick={stopStream}
              >
                <span className="sq" />
              </button>
            ) : (
              <button
                type="button"
                className="ib-send"
                data-testid="chat-send"
                title={t('input.send')}
                aria-label={t('input.sendAria')}
                disabled={trimmed.length === 0}
                onClick={() => submit(value)}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2 7.5 8.5M14 2l-4.4 12L7.5 8.5 2 6.6 14 2Z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="ib-hint">
        {t('input.hintSend')}<span className="sep">·</span>{t('input.hintNewline')}<span className="sep">·</span>
        <span className="model">{state.model}</span>
      </div>
    </div>
  )
}
