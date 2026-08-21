// packages/web/src/frame/AppFrame.tsx — ChatGPT-desktop-style app shell.
// 44px top bar: [collapse] ⚡RoboJex · view tabs (对话/任务板/日历/活动/驾驶舱,
// gradient underline, icon-only <1100px) · HUD cluster · ⌘K · ⚙ · theme cycle
// · details toggle. Main: Sidebar 240px (collapses to 0 with a width tween;
// expand button appears in the top bar) | view 1fr (150ms crossfade) |
// DetailsPanel 320px (closable column; right overlay drawer <900px).
// Ctrl+K opens the command palette; Settings is a modal overlay.

import { useCallback, useEffect, useState } from 'react'
import { ChatView } from '../chat/ChatView'
import { DetailsPanel } from '../details/DetailsPanel'
import { Sidebar } from '../sidebar/Sidebar'
import { useStore } from '../state/store'
import type { ThemeApi, ThemePref } from '../state/theme'
import { ActivityFeed } from '../views/ActivityFeed'
import { AgendaView } from '../views/AgendaView'
import { BoardView } from '../views/BoardView'
import { GearPanel } from '../views/GearPanel'
import { SettingsView } from '../views/SettingsView'
import { VIEW_META } from '../views/ViewSwitcher'
import { loadFlag, loadView, saveFlag, saveView } from '../views/viewState'
import type { ViewId } from '../views/viewState'
import { CommandPalette } from './CommandPalette'
import { HudBar } from './HudBar'
import './frame.css'

const NARROW_QUERY = '(max-width: 899px)'

const THEME_CYCLE: ThemePref[] = ['light', 'dark', 'system']

/* ── inline icons ── */

const CollapseIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" />
    <path d="M8.5 6.5 10.5 8l-2 1.5" />
  </svg>
)
const ExpandIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" />
    <path d="M9.5 6.5 11.5 8l-2 1.5" />
  </svg>
)
const SearchIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </svg>
)
const GearIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
  </svg>
)
const PanelIcon = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <line x1="10" y1="2.5" x2="10" y2="13.5" />
  </svg>
)
const ThemeIcon = ({ pref }: { pref: ThemePref }) =>
  pref === 'light' ? (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="3.2" />
      <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
    </svg>
  ) : pref === 'dark' ? (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.2 9.9A5.6 5.6 0 0 1 6.1 2.8a5.6 5.6 0 1 0 7.1 7.1Z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="8.5" rx="1.5" />
      <path d="M5.5 13.5h5" />
    </svg>
  )

export function AppFrame({ theme }: { theme: ThemeApi }) {
  const { state, selectTask } = useStore()

  /* view (persisted; chat pane stays mounted, only hidden) */
  const [view, setView] = useState<ViewId>(loadView)
  const changeView = useCallback((v: ViewId) => {
    setView(v)
    saveView(v)
  }, [])

  /* frame layout flags (persisted) */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadFlag('sidebar-collapsed', false))
  const [detailsOpen, setDetailsOpen] = useState(() => loadFlag('details-open', false))
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => {
      saveFlag('sidebar-collapsed', !c)
      return !c
    })
  }, [])
  const toggleDetails = useCallback(() => {
    setDetailsOpen((o) => {
      saveFlag('details-open', !o)
      return !o
    })
  }, [])

  /* overlays */
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  /* responsive: <900px → sidebar & details become overlay drawers */
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => {
      setNarrow(mq.matches)
      if (mq.matches) {
        // entering narrow: drawers start closed
        setSidebarCollapsed(true)
        saveFlag('sidebar-collapsed', true)
      }
    }
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  /* global Ctrl/⌘+K toggles the palette */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSettingsOpen(false)
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* selecting a task reveals the details column/drawer */
  useEffect(() => {
    if (state.selectedTaskId !== null) {
      setDetailsOpen(true)
      saveFlag('details-open', true)
    }
  }, [state.selectedTaskId])

  const sidebarNode = (
    <Sidebar
      theme={theme}
      overlay={narrow}
      onCollapse={toggleSidebar}
      view={view}
      onView={changeView}
    />
  )

  const detailsNode = <DetailsPanel onClose={toggleDetails} />

  return (
    <div className="rj-app">
      {/* ── top bar ── */}
      <header className="rj-topbar">
        <button
          type="button"
          className="tb-btn"
          data-testid={sidebarCollapsed ? 'sidebar-expand' : 'sidebar-collapse'}
          title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? ExpandIcon : CollapseIcon}
        </button>
        <div className="rj-brand" title="RoboJex — 常驻桌面 AI 系统">
          <span className="brand-orb">⚡</span>
          <span className="brand-name">RoboJex</span>
        </div>
        <nav className="rj-tabs" role="tablist" aria-label="视图">
          {VIEW_META.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              className="rj-tab"
              data-testid="view-tab"
              data-view={m.id}
              data-active={view === m.id}
              aria-selected={view === m.id}
              title={m.label}
              onClick={() => changeView(m.id)}
            >
              {m.icon}
              <span className="tab-label">{m.label}</span>
            </button>
          ))}
        </nav>
        <div className="rj-topbar-right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <HudBar />
          <button
            type="button"
            className="tb-k"
            title="命令面板 (Ctrl+K)"
            onClick={() => {
              setSettingsOpen(false)
              setPaletteOpen(true)
            }}
          >
            {SearchIcon}
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className="tb-btn"
            data-testid="settings-open"
            title="设置"
            aria-label="打开设置"
            onClick={() => {
              setPaletteOpen(false)
              setSettingsOpen(true)
            }}
          >
            {GearIcon}
          </button>
          <button
            type="button"
            className="tb-btn"
            data-testid="theme-toggle"
            title={`主题：${theme.pref} — 点击切换 浅色 → 深色 → 跟随系统`}
            aria-label="切换主题"
            onClick={() => {
              const idx = THEME_CYCLE.indexOf(theme.pref)
              theme.setPref(THEME_CYCLE[(idx + 1) % THEME_CYCLE.length] ?? 'dark')
            }}
          >
            <ThemeIcon pref={theme.pref} />
          </button>
          <button
            type="button"
            className={`tb-btn${detailsOpen ? ' on' : ''}`}
            title={detailsOpen ? '关闭详情面板' : '打开详情面板'}
            aria-label="切换详情面板"
            aria-pressed={detailsOpen}
            onClick={toggleDetails}
          >
            {PanelIcon}
          </button>
        </div>
      </header>

      {/* ── main columns ── */}
      <div className="rj-main">
        {!narrow ? (
          <>
            <div className={`rj-sidebar-col${sidebarCollapsed ? ' collapsed' : ''}`}>
              <div className="rj-sidebar-inner">{sidebarNode}</div>
            </div>
            <main className="rj-view">
              {/* chat stays mounted — hidden, not unmounted — so the
               * transcript scroll and input draft survive view round-trips */}
              <div className={`rj-view-page${view === 'chat' ? '' : ' offscreen'}`}>
                <ChatView />
              </div>
              {view !== 'chat' ? (
                <div className="rj-view-page rj-fade" key={view}>
                  {view === 'board' ? <BoardView /> : null}
                  {view === 'agenda' ? (
                    <AgendaView
                      onOpenTask={(id) => {
                        selectTask(id)
                        changeView('board')
                      }}
                    />
                  ) : null}
                  {view === 'activity' ? <ActivityFeed /> : null}
                  {view === 'cockpit' ? <GearPanel /> : null}
                </div>
              ) : null}
            </main>
            {detailsOpen ? (
              <div className="rj-details-col">
                <div className="rj-details-inner">{detailsNode}</div>
              </div>
            ) : null}
          </>
        ) : (
          <main className="rj-view">
            <div className={`rj-view-page${view === 'chat' ? '' : ' offscreen'}`}>
              <ChatView />
            </div>
            {view !== 'chat' ? (
              <div className="rj-view-page rj-fade" key={view}>
                {view === 'board' ? <BoardView /> : null}
                {view === 'agenda' ? (
                  <AgendaView
                    onOpenTask={(id) => {
                      selectTask(id)
                      changeView('board')
                    }}
                  />
                ) : null}
                {view === 'activity' ? <ActivityFeed /> : null}
                {view === 'cockpit' ? <GearPanel /> : null}
              </div>
            ) : null}
          </main>
        )}
      </div>

      {/* ── narrow overlay drawers ── */}
      {narrow && !sidebarCollapsed ? (
        <>
          <div className="rj-drawer-backdrop" onClick={toggleSidebar} />
          <div className="rj-drawer left">{sidebarNode}</div>
        </>
      ) : null}
      {narrow && detailsOpen ? (
        <>
          <div
            className="rj-drawer-backdrop"
            onClick={() => {
              setDetailsOpen(false)
              saveFlag('details-open', false)
            }}
          />
          <div className="rj-drawer right rj-drawer-in-right">{detailsNode}</div>
        </>
      ) : null}

      {/* ── overlays ── */}
      {paletteOpen ? (
        <CommandPalette theme={theme} onClose={() => setPaletteOpen(false)} onView={changeView} />
      ) : null}
      {settingsOpen ? <SettingsView onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}
