// packages/web/src/views/boardFocus.ts — CmdK → board create-input focus
// handoff. The palette may fire from any view; the board consumes the
// request both at mount (right after a view switch remounts it — the flag
// survives until then) and live (already on board — the event lands),
// hence the flag + event pair instead of either alone.

let requested = false

/** Request the board's create-input focus (CmdK "new task"). */
export function requestBoardFocus(): void {
  requested = true
  window.dispatchEvent(new CustomEvent('robojex:board-focus'))
}

/** Subscribe a consumer: fires immediately if a request is pending (fresh
 *  mount after a view switch), then on every live request. Returns the
 *  teardown for useEffect cleanup. */
export function takeBoardFocus(onTake: () => void): () => void {
  const h = (): void => {
    requested = false
    onTake()
  }
  if (requested) h()
  window.addEventListener('robojex:board-focus', h)
  return () => window.removeEventListener('robojex:board-focus', h)
}
