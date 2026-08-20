// packages/web/src/frame/AppFrame.tsx — three-column shell (DSH AppFrame clone).
// CSS Grid `sidebar 260px | minmax(0,1fr) | details`; below 900px the sidebar
// concedes to a 56px control rail and details turns into a right drawer.
// Boundaries drag with pointer capture, width writes coalesced through rAF.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { ChatStream } from '../chat/ChatStream'
import { InputBar } from '../chat/InputBar'
import { DetailsPanel } from '../details/DetailsPanel'
import { Sidebar } from '../sidebar/Sidebar'
import { useStore } from '../state/store'
import type { ThemeApi } from '../state/theme'
import { AgendaView } from '../views/AgendaView'
import { BoardView } from '../views/BoardView'
import { loadView, saveView } from '../views/viewState'
import type { ViewId } from '../views/viewState'

const SIDEBAR_DEFAULT = 260
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 420
const RAIL = 56
const DETAILS_DEFAULT = 360
const DETAILS_MIN = 200
const DETAILS_MAX = 520
const NARROW_QUERY = '(max-width: 899px)'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * Pointer-capture drag with rAF-throttled width writes. `apply` receives the
 * gesture's accumulated delta in px; the consumer maps it to a column width.
 */
function useColumnDrag(
  apply: (dx: number) => void,
  end: () => void,
): {
  dragging: boolean
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void
} {
  const [dragging, setDragging] = useState(false)
  const active = useRef(false)
  const startX = useRef(0)
  const lastX = useRef(0)
  const raf = useRef(0)
  const applyRef = useRef(apply)
  const endRef = useRef(end)
  applyRef.current = apply
  endRef.current = end

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    active.current = true
    startX.current = e.clientX
    lastX.current = e.clientX
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!active.current) return
    lastX.current = e.clientX
    if (raf.current !== 0) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      applyRef.current(lastX.current - startX.current)
    })
  }, [])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!active.current) return
    active.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (raf.current !== 0) {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
    setDragging(false)
    endRef.current()
  }, [])

  return { dragging, onPointerDown, onPointerMove, onPointerUp }
}

export function AppFrame({ theme }: { theme: ThemeApi }) {
  const { state, selectTask } = useStore()
  const [sidebarW, setSidebarW] = useState(SIDEBAR_DEFAULT)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [detailsW, setDetailsW] = useState(0)
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  // Center view (Chat/Board/Agenda), persisted; chat state survives switches
  // because the pane is only hidden, never unmounted.
  const [view, setView] = useState<ViewId>(loadView)
  const changeView = useCallback((v: ViewId) => {
    setView(v)
    saveView(v)
  }, [])

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => setNarrow(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Selecting a task reveals its details column (wide: resize; narrow: drawer).
  useEffect(() => {
    if (state.selectedTaskId !== null && detailsW === 0) setDetailsW(DETAILS_DEFAULT)
    // detailsW intentionally not a dependency: only selection opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedTaskId])

  const sidebarBase = useRef(sidebarW)
  const sidebarDrag = useColumnDrag(
    (dx) => setSidebarW(clamp(sidebarBase.current + dx, SIDEBAR_MIN, SIDEBAR_MAX)),
    () => {
      // A drag that landed under the rail threshold collapses the sidebar.
      if (sidebarBase.current >= SIDEBAR_MIN && sidebarW < SIDEBAR_MIN) setSidebarCollapsed(true)
    },
  )
  const beginSidebar = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    sidebarBase.current = sidebarW
    sidebarDrag.onPointerDown(e)
  }, [sidebarDrag, sidebarW]) // eslint-disable-line react-hooks/exhaustive-deps

  const detailsBase = useRef(detailsW)
  const detailsDrag = useColumnDrag(
    (dx) => setDetailsW(clamp(detailsBase.current - dx, 0, DETAILS_MAX)),
    () => {
      // Snap a hair-trigger open into a usable width; a near-zero release closes.
      setDetailsW((w) => (w === 0 ? 0 : w < DETAILS_MIN ? DETAILS_MIN : w))
    },
  )
  const beginDetails = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    detailsBase.current = detailsW
    detailsDrag.onPointerDown(e)
  }, [detailsDrag, detailsW]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wide viewports: rail when collapsed, full sidebar otherwise. Narrow
  // (<900px) viewports always show the rail; the expand button overlays the
  // full sidebar instead of squeezing the center column.
  const showRail = narrow || sidebarCollapsed
  const sidebarColW = showRail ? RAIL : sidebarW
  const dragging = sidebarDrag.dragging || detailsDrag.dragging

  return (
    <div
      className={`app-frame${dragging ? ' dragging' : ''}`}
      style={
        narrow
          ? { gridTemplateColumns: `${RAIL}px minmax(0,1fr)` }
          : { gridTemplateColumns: `${sidebarColW}px minmax(0,1fr) ${detailsW}px` }
      }
    >
      <div className="col-sidebar">
        {showRail ? (
          <SidebarRail
            conn={state.conn}
            mode={state.mode}
            onExpand={() => (narrow ? setNarrowExpanded(true) : setSidebarCollapsed(false))}
          />
        ) : (
          <>
            <Sidebar
              theme={theme}
              onCollapse={() => setSidebarCollapsed(true)}
              view={view}
              onView={changeView}
            />
            <div
              className="handle-sidebar"
              onPointerDown={beginSidebar}
              onPointerMove={sidebarDrag.onPointerMove}
              onPointerUp={sidebarDrag.onPointerUp}
              onPointerCancel={sidebarDrag.onPointerUp}
            />
          </>
        )}
        {narrow && narrowExpanded ? (
          <Sidebar
            theme={theme}
            overlay
            onCollapse={() => setNarrowExpanded(false)}
            view={view}
            onView={changeView}
          />
        ) : null}
      </div>

      <div className="col-center">
        {/* Chat pane (stream + input) is hidden — never unmounted — while
         * Board/Agenda show, so the transcript scroll and the input draft
         * survive round-trips. Input is chat-only (spec): invisible elsewhere. */}
        <div className={`chat-pane${view === 'chat' ? '' : ' offscreen'}`}>
          <ChatStream />
          <InputBar />
        </div>
        {view === 'board' ? <BoardView /> : null}
        {view === 'agenda' ? (
          <AgendaView
            onOpenTask={(id) => {
              selectTask(id)
              changeView('board')
            }}
          />
        ) : null}
      </div>

      {narrow ? (
        detailsW > 0 || state.selectedTaskId !== null ? (
          <div className="details drawer">
            <DetailsPanel
              onClose={() => {
                setDetailsW(0)
                selectTask(null)
              }}
            />
          </div>
        ) : null
      ) : (
        <div className="col-details" style={{ width: detailsW }}>
          {detailsW > 0 ? <DetailsPanel onClose={() => setDetailsW(0)} /> : null}
          <div
            className="handle-details"
            onPointerDown={beginDetails}
            onPointerMove={detailsDrag.onPointerMove}
            onPointerUp={detailsDrag.onPointerUp}
            onPointerCancel={detailsDrag.onPointerUp}
          >
            <span className="pill" />
          </div>
        </div>
      )}
    </div>
  )
}

/** 56px icon rail shown when the sidebar is collapsed or the viewport is narrow. */
function SidebarRail({
  conn,
  mode,
  onExpand,
}: {
  conn: 'connecting' | 'live' | 'reconnecting'
  mode: string
  onExpand(): void
}) {
  return (
    <div className="rail" title={`jex · ${mode}`}>
      <div className="logo">j</div>
      <span className={`conn-dot ${conn}`} title={`connection: ${conn}`} />
      <div className="spacer" />
      <button
        className="icon-btn"
        title="Expand sidebar"
        aria-label="Expand sidebar"
        onClick={onExpand}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" />
          <path d="M9 6.5 11 8 9 9.5" />
        </svg>
      </button>
    </div>
  )
}
