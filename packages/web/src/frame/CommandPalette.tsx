// packages/web/src/frame/CommandPalette.tsx — Ctrl+K palette (centered 640px,
// blurred backdrop, scale-in). Searches conversations (store.state) and offers
// grouped actions: new chat · switch view ×5 · theme ×3 · language cycle
// (zh→en→system) · gear ×5. Keyboard: ↑/↓ move, Enter run, Esc close.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, statusTone } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { LangPref } from '../i18n'
import type { ThemeApi } from '../state/theme'
import type { GearId } from '../state/types'
import { gearsOrFallback, localizeGears } from '../views/gearDefs'
import { VIEW_META } from '../views/ViewSwitcher'
import { Icon, gearIcon } from '../ui/Icon'
import { matchesInitials } from './pinyin'
import { requestBoardFocus } from '../views/boardFocus'
import type { ViewId } from '../views/viewState'

interface CmdItem {
  id: string
  group: string
  label: string
  hint?: string
  icon: JSX.Element
  run(): void
}

/** Language cycle for the palette's switch-language action. */
const LANG_CYCLE: LangPref[] = ['zh', 'en', 'system']

export function CommandPalette({
  theme,
  onClose,
  onView,
}: {
  theme: ThemeApi
  onClose(): void
  onView(view: ViewId): void
}) {
  const store = useStore()
  const { t, pref: langPref, setPref: setLangPrefState } = useT()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const items = useMemo<CmdItem[]>(() => {
    const out: CmdItem[] = []
    for (const c of store.state.conversations) {
      out.push({
        id: `conv-${c.id}`,
        group: t('cmdk.groupConv'),
        label: c.title || t('cmdk.untitled'),
        hint: c.preview,
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 3.5h11v8H8l-3.2 2.6V11.5h-2.3z" />
          </svg>
        ),
        run: () => {
          void store.selectConversation(c.id)
          onView('chat')
        },
      })
    }
    out.push({
      id: 'act-new-conv',
      group: t('cmdk.groupAction'),
      label: t('cmdk.newChat'),
      icon: <Icon name="message" size={14} />,
      run: () => {
        void store.newConversation()
        onView('chat')
      },
    })
    out.push({
      id: 'act-new-task',
      group: t('cmdk.groupAction'),
      label: t('cmdk.newTask'),
      hint: t('cmdk.newTaskHint'),
      icon: <Icon name="plus" size={14} />,
      run: () => {
        requestBoardFocus()
        onView('board')
      },
    })
    // task search: as the board grows, finding one card means hunting
    // lanes — the palette finds it from anywhere (substring, user content
    // like conversation titles; cancelled history stays out)
    for (const tk of store.state.tasks.filter((x) => x.status !== 'cancelled').slice(-30).reverse()) {
      out.push({
        id: `task-${tk.id}`,
        group: t('cmdk.groupTask'),
        label: tk.title,
        hint: t(`status.${tk.status}`),
        icon: <span className={`dot ${statusTone(tk.status)}`} style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none' }} />,
        run: () => {
          void store.selectTask(tk.id)
          onView('board')
        },
      })
    }
    for (const m of VIEW_META) {
      out.push({
        id: `act-view-${m.id}`,
        group: t('cmdk.groupAction'),
        label: fill(t('cmdk.switchView'), { view: t(m.labelKey) }),
        icon: m.icon,
        run: () => onView(m.id),
      })
    }
    for (const pref of ['light', 'dark', 'system'] as const) {
      out.push({
        id: `act-theme-${pref}`,
        group: t('cmdk.groupAction'),
        label: fill(t('cmdk.theme'), { name: t(`theme.${pref}`) }),
        icon: <Icon name={pref === 'light' ? 'sun' : pref === 'dark' ? 'moon' : 'partial'} size={14} />,
        run: () => theme.setPref(pref),
      })
    }
    // language: cycles zh → en → system from the CURRENT preference
    const nextLang = LANG_CYCLE[(LANG_CYCLE.indexOf(langPref) + 1) % LANG_CYCLE.length] ?? 'zh'
    out.push({
      id: 'act-lang-cycle',
      group: t('cmdk.groupAction'),
      label: fill(t('cmdk.switchLang'), { next: t(`lang.${nextLang}`) }),
      icon: <Icon name="repeat" size={14} />,
      run: () => setLangPrefState(nextLang),
    })
    for (const g of localizeGears(gearsOrFallback(store.state.gears), t)) {
      out.push({
        id: `act-gear-${g.id}`,
        group: t('cmdk.groupAction'),
        label: fill(t('cmdk.gear'), { name: g.name, id: g.id }),
        hint: g.cost,
        icon: <Icon name={gearIcon(g.id)} size={14} />,
        run: () => void store.changeGear(g.id as GearId),
      })
    }
    return out
  }, [store, theme, onView, t, langPref, setLangPrefState])

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!q) return items
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.hint ? it.hint.toLowerCase().includes(q) : false) ||
        it.group.includes(q) ||
        // pinyin initials: jsc finds 驾驶舱, dh finds 对话 (see pinyin.ts)
        matchesInitials(it.label, q),
    )
  }, [items, q])

  // Clamp the cursor when the filtered list shrinks.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, visible.length - 1)))
  }, [visible.length])

  // Focus the input on open.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keep the active row in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const exec = (item: CmdItem | undefined): void => {
    if (!item) return
    item.run()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    // focus trap: Tab must not escape the dialog into the page behind it.
    // The input and item buttons are the cycle; wrap at both ends.
    if (e.key === 'Tab') {
      const focusables = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('.cmdk-item') ?? [],
      )
      const first: HTMLElement | null = inputRef.current
      const last: HTMLElement | null = focusables.length > 0 ? focusables[focusables.length - 1] : first
      const cur = document.activeElement
      if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first?.focus()
      } else if (e.shiftKey && cur === first) {
        e.preventDefault()
        last?.focus()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      exec(visible[active])
    }
  }

  // Grouped rendering over the flat visible list.
  const rows: JSX.Element[] = []
  let lastGroup = ''
  visible.forEach((it, i) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group
      rows.push(
        <div key={`g-${it.group}`} className="cmdk-group-label">
          {it.group}
        </div>,
      )
    }
    rows.push(
      <button
        key={it.id}
        type="button"
        className={`cmdk-item${i === active ? ' active' : ''}`}
        data-idx={i}
        onMouseEnter={() => setActive(i)}
        onClick={() => exec(it)}
      >
        <span className="ci-icon">{it.icon}</span>
        <span className="ci-label">{it.label}</span>
        {it.hint ? <span className="ci-hint">{it.hint}</span> : null}
      </button>,
    )
  })

  return (
    <div
      className="cmdk-backdrop"
      data-testid="cmdk"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('cmdk.aria')}
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-input-row">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            ref={inputRef}
            className="cmdk-input"
            data-testid="cmdk-input"
            value={query}
            placeholder={t('cmdk.placeholder')}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-body" ref={listRef}>
          {visible.length === 0 ? (
            <div className="cmdk-empty">{t('cmdk.empty')}</div>
          ) : (
            rows
          )}
        </div>
        <div className="cmdk-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>{t('cmdk.footSelect')}
          </span>
          <span>
            <kbd>↵</kbd>{t('cmdk.footRun')}
          </span>
          <span>
            <kbd>esc</kbd>{t('cmdk.footClose')}
          </span>
        </div>
      </div>
    </div>
  )
}
