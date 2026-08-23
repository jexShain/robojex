// packages/web/src/sidebar/Sidebar.tsx — conversation sidebar: brand row,
// new-chat, search, grouped list (置顶[pin icon]/今天/昨天/近 7 天/更早) with hover +
// context-menu actions (pin / inline rename / delete-with-confirm), skeleton
// while loading, and a jex status card (gear-colored breathing dot, connection
// state, version). Zero required props — <Sidebar /> just works; collapse goes
// through window.robojex?.collapseSidebar?.() when the shell provides it.

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { fill } from '../i18n'
import type { Conversation } from '../state/types'
import type { ThemeApi } from '../state/theme'
import { gearsOrFallback, localizeGears } from '../views/gearDefs'
import type { ViewId } from '../views/viewState'
import { Icon } from '../ui/Icon'
import { GROUP_ICON, groupConversations, relTime } from './grouping'
import './sidebar.css'

interface MenuState {
  id: string
  x: number
  y: number
}

function BoltIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  )
}
function PinIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5M9 10.8V4h6v6.8l2.7 2.7a1 1 0 0 1-.7 1.7H7a1 1 0 0 1-.7-1.7Z" />
    </svg>
  )
}
function PencilIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}
function TrashIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}
function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}
function CollapseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <line x1="9" y1="4" x2="9" y2="20" />
      <path d="m16.5 9.5-2.5 2.5 2.5 2.5" />
    </svg>
  )
}

function ConvItem({
  conv,
  active,
  unread,
  staggerMs,
  editing,
  confirming,
  onOpen,
  onStartRename,
  onStartConfirm,
  onRename,
  onCancel,
  onPin,
  onDelete,
  onContext,
}: {
  conv: Conversation
  active: boolean
  /** parked jex briefings (session-local; cleared on open). */
  unread: number
  staggerMs: number
  editing: boolean
  confirming: boolean
  onOpen(): void
  onStartRename(): void
  onStartConfirm(): void
  onRename(title: string): void
  onCancel(): void
  onPin(): void
  onDelete(): void
  onContext(e: ReactMouseEvent): void
}): JSX.Element {
  const { t, lang } = useT()
  const [draft, setDraft] = useState(conv.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(conv.title)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, conv.title])

  const renameKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') onRename(draft.trim() || conv.title)
    else if (e.key === 'Escape') onCancel()
  }

  return (
    <div
      className={`sb-item${active ? ' active' : ''}`}
      data-testid="conv-item"
      data-active={active ? 'true' : 'false'}
      style={{ animationDelay: `${Math.min(staggerMs, 300)}ms` } as CSSProperties}
      onClick={onOpen}
      onContextMenu={onContext}
      title={conv.title}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="sb-rename"
          value={draft}
          spellCheck={false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={renameKey}
          onBlur={() => onRename(draft.trim() || conv.title)}
        />
      ) : (
        <>
          <div className="sb-item-top">
            <span className="sb-title">{conv.title}</span>
            {unread > 0 ? (
              <span className="sb-unread" data-testid="conv-unread" title={t('side.unreadAria')}>
                {unread > 9 ? '9+' : unread}
              </span>
            ) : null}
            <span className="sb-time">{relTime(conv.updatedAt, Date.now(), lang)}</span>
          </div>
          <div className="sb-preview">
            {conv.preview || (conv.messageCount > 0 ? fill(t('side.messages'), { n: conv.messageCount }) : t('side.newChat'))}
          </div>
          <div className="sb-acts" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="sb-act"
              data-testid="conv-pin"
              title={conv.pinned === 1 ? t('side.unpin') : t('side.pin')}
              aria-label={conv.pinned === 1 ? t('side.unpin') : t('side.pin')}
              onClick={onPin}
            >
              <PinIcon />
            </button>
            <button
              type="button"
              className="sb-act"
              data-testid="conv-rename"
              title={t('side.rename')}
              aria-label={t('side.rename')}
              onClick={onStartRename}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="sb-act danger"
              data-testid="conv-delete"
              title={t('side.delete')}
              aria-label={t('side.deleteConvAria')}
              onClick={onStartConfirm}
            >
              <TrashIcon />
            </button>
          </div>
          {confirming ? (
            <div className="sb-confirm" onClick={(e) => e.stopPropagation()}>
              <span className="q">{fill(t('side.deleteConfirm'), { title: conv.title })}</span>
              <button type="button" className="sb-confirm-btn del" onClick={onDelete}>
                {t('side.delete')}
              </button>
              <button type="button" className="sb-confirm-btn" onClick={onCancel}>
                {t('chat.cancel')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/**
 * AppFrame passes its full shell wiring; the sidebar consumes `overlay` and
 * `onCollapse` only — view switching lives in the top bar by spec. Collapse
 * prefers the Electron bridge (window.robojex.collapseSidebar) and falls back
 * to the shell callback.
 */
export function Sidebar(props: {
  theme?: ThemeApi
  overlay?: boolean
  onCollapse?: () => void
  view?: ViewId
  onView?: (view: ViewId) => void
} = {}) {
  const { overlay = false, onCollapse } = props
  const {
    state,
    newConversation,
    selectConversation,
    renameConversation,
    togglePinConversation,
    deleteConversationById,
  } = useStore()
  const { t, lang } = useT()
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const gears = useMemo(() => localizeGears(gearsOrFallback(state.gears), t), [state.gears, t])
  const gearLevel = gears.find((g) => g.id === state.gear)?.level ?? 2
  const gearName = gears.find((g) => g.id === state.gear)?.name ?? state.gear
  const connLabel = (conn: string): string =>
    t(`side.conn.${conn}`) === `side.conn.${conn}` ? conn : t(`side.conn.${conn}`)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return state.conversations
    return state.conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q),
    )
  }, [state.conversations, query])

  const groups = useMemo(() => groupConversations(filtered, undefined, lang), [filtered, lang])
  const activeId = state.activeConvId

  /* close the context menu on any outside pointer / scroll / Esc */
  useEffect(() => {
    if (!menu) return
    const close = (e: Event): void => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      setMenu(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const menuConv = menu ? state.conversations.find((c) => c.id === menu.id) : undefined

  const clampMenu = (x: number, y: number): { x: number; y: number } => ({
    x: Math.min(x, window.innerWidth - 170),
    y: Math.min(y, window.innerHeight - 150),
  })

  const collapse = (): void => {
    const w = window as unknown as { robojex?: { collapseSidebar?: () => void } }
    if (typeof w.robojex?.collapseSidebar === 'function') w.robojex.collapseSidebar()
    else onCollapse?.()
  }

  let stagger = 0

  return (
    <aside
      className={`sb${overlay ? ' overlay' : ''}`}
      style={{ '--rj-gear-current': `var(--rj-gear-${gearLevel})` } as CSSProperties}
    >
      <div className="sb-brand">
        <div className="sb-orb">
          <BoltIcon />
        </div>
        <div className="sb-brand-text">
          <div className="sb-brand-name">RoboJex</div>
          <div className="sb-brand-sub">{fill(t('side.brandSub'), { name: gearName })}</div>
        </div>
        <button
          type="button"
          className="sb-collapse"
          title={t('side.collapse')}
          aria-label={t('side.collapse')}
          onClick={collapse}
        >
          <CollapseIcon />
        </button>
      </div>

      <button
        type="button"
        className="sb-new"
        data-testid="sidebar-new-chat"
        onClick={() => void newConversation()}
      >
        <span className="plus" aria-hidden="true">＋</span>{t('side.newChat')}
      </button>

      <div className="sb-search">
        <SearchIcon />
        <input
          type="text"
          value={query}
          placeholder={t('side.search')}
          spellCheck={false}
          aria-label={t('side.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <nav className="sb-list" aria-label={t('side.listAria')}>
        {state.convsLoading ? (
          <div className="sb-skel" aria-label={t('side.loading')}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="row rj-skeleton" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="sb-empty">
            {query ? t('side.emptySearch') : t('side.empty')}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.key} data-group={g.key}>
              <div className="sb-group-label">
                {GROUP_ICON[g.key] ? (
                  <Icon name={GROUP_ICON[g.key]!} size={12} style={{ marginRight: 4 }} />
                ) : null}
                {g.label}
              </div>
              {g.items.map((c) => (
                <ConvItem
                  key={c.id}
                  conv={c}
                  active={c.id === activeId}
                  unread={state.unread[c.id] ?? 0}
                  staggerMs={(stagger += 30)}
                  editing={editingId === c.id}
                  confirming={confirmId === c.id}
                  onOpen={() => {
                    if (editingId !== c.id) void selectConversation(c.id)
                  }}
                  onStartRename={() => {
                    setConfirmId(null)
                    setEditingId(c.id)
                  }}
                  onStartConfirm={() => {
                    setEditingId(null)
                    setConfirmId(c.id)
                  }}
                  onRename={(title) => {
                    setEditingId(null)
                    if (title !== c.title) void renameConversation(c.id, title)
                  }}
                  onCancel={() => {
                    setEditingId(null)
                    setConfirmId(null)
                  }}
                  onPin={() => void togglePinConversation(c.id, c.pinned !== 1)}
                  onDelete={() => {
                    setConfirmId(null)
                    void deleteConversationById(c.id)
                  }}
                  onContext={(e) => {
                    e.preventDefault()
                    setMenu({ id: c.id, x: e.clientX, y: e.clientY })
                  }}
                />
              ))}
            </div>
          ))
        )}
      </nav>

      <div className="sb-foot">
        <div
          className="sb-status"
          data-testid="conn-status"
          title={`jex · ${gearName} · ${connLabel(state.conn)}${state.version ? ` · v${state.version}` : ''}`}
        >
          <span className="sb-status-dot" />
          <div className="sb-status-text">
            <span className="sb-status-name">
              {fill(t('side.gearSuffix'), { name: gearName })}
            </span>
            <span className={`sb-status-conn ${state.conn}`}>{connLabel(state.conn)}</span>
          </div>
          {state.version ? <span className="sb-status-ver">v{state.version}</span> : null}
        </div>
      </div>

      {menu && menuConv ? (
        <div
          ref={menuRef}
          className="sb-menu"
          style={clampMenu(menu.x, menu.y)}
          role="menu"
          aria-label={t('side.menuAria')}
        >
          <button
            type="button"
            className="sb-menu-item"
            role="menuitem"
            onClick={() => {
              void togglePinConversation(menuConv.id, menuConv.pinned !== 1)
              setMenu(null)
            }}
          >
            <span className="mi"><Icon name="pin" size={13} /></span>
            {menuConv.pinned === 1 ? t('side.unpin') : t('side.pin')}
          </button>
          <button
            type="button"
            className="sb-menu-item"
            role="menuitem"
            onClick={() => {
              setEditingId(menuConv.id)
              setMenu(null)
            }}
          >
            <span className="mi"><PencilIcon /></span>{t('side.rename')}
          </button>
          <button
            type="button"
            className="sb-menu-item danger"
            role="menuitem"
            onClick={() => {
              setConfirmId(menuConv.id)
              setMenu(null)
            }}
          >
            <span className="mi"><TrashIcon /></span>{t('side.delete')}
          </button>
        </div>
      ) : null}
    </aside>
  )
}
