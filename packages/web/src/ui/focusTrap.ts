// packages/web/src/ui/focusTrap.ts — modal focus trap. A dialog that lets
// Tab walk into the page behind it is a modal that leaks; both the command
// palette and the settings sheet wrap Tab/Shift+Tab inside their bounds.

/** Wrap Tab/Shift+Tab inside `root`'s focusable elements. Call from the
 *  dialog's onKeyDown for the 'Tab' key only. */
export function trapTab(
  e: { shiftKey: boolean; preventDefault(): void },
  root: HTMLElement | null,
): void {
  if (!root) return
  const els = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null)
  if (els.length === 0) return
  const first = els[0]
  const last = els[els.length - 1]
  const cur = document.activeElement
  if (!e.shiftKey && (cur === last || !root.contains(cur))) {
    e.preventDefault()
    first.focus()
  } else if (e.shiftKey && (cur === first || !root.contains(cur))) {
    e.preventDefault()
    last.focus()
  }
}
