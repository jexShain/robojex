// packages/web/src/state/desktop.ts — the desktop-shell bridge surface
// (window.robojex only exists inside Electron; every call here is a silent
// no-op in a plain browser). Tray-status mirror + launch-at-login helpers,
// kept pure so packages/web/test/desktop.test.ts can pin the payload shape.

import type { GearDef } from './types'
import { GEAR_FALLBACK, gearDisplayName } from '../views/gearDefs'

/** Payload the Electron main process mirrors into the tray tooltip + menu
 *  radios. `gear` is the numeric level (0..4) matching the shell's GEARS
 *  table — the shell never parses gear ids, the renderer owns the mapping. */
export interface TrayStatus {
  gear: number
  label: string
  connected: boolean
}

/** Map the live gear id + connection state to a tray payload. Level comes
 *  from the server catalog, then the static fallback, then balanced (2) —
 *  an unknown gear must never crash the shell's radio lookup. */
export function trayStatusFor(gearId: string, gears: GearDef[], connected: boolean): TrayStatus {
  const def = gears.find((g) => g.id === gearId) ?? GEAR_FALLBACK.find((g) => g.id === gearId)
  const name = gearDisplayName(gearId)
  return {
    gear: def?.level ?? 2,
    label: def?.emoji ? `${def.emoji} ${name}` : name,
    connected,
  }
}

interface DesktopBridge {
  robojex?: {
    setTrayStatus?: (p: TrayStatus) => void
    autostart?: {
      get?: () => Promise<boolean>
      set?: (enabled: boolean) => Promise<boolean>
    }
  }
}

const bridge = (): DesktopBridge['robojex'] =>
  (typeof window === 'undefined' ? undefined : (window as unknown as DesktopBridge).robojex)

/** Fire-and-forget push; tooltip freshness is never worth a UI error. */
export function pushTrayStatus(status: TrayStatus): void {
  try {
    bridge()?.setTrayStatus?.(status)
  } catch {
    /* bridge hiccup */
  }
}

/** Does this shell expose the launch-at-login controls? Gates the settings
 *  row between a live toggle and the read-only badge display. */
export function hasAutostartBridge(): boolean {
  const a = bridge()?.autostart
  return typeof a?.get === 'function' && typeof a?.set === 'function'
}

/** Read the OS launch-at-login flag; null = unavailable or failed. */
export function readAutostart(): Promise<boolean | null> {
  if (!hasAutostartBridge()) return Promise.resolve(null)
  return bridge()!.autostart!.get!().then(
    (v) => (typeof v === 'boolean' ? v : null),
    () => null,
  )
}

/** Flip the OS flag; resolves the post-write OS truth, null on failure. */
export function writeAutostart(enabled: boolean): Promise<boolean | null> {
  if (!hasAutostartBridge()) return Promise.resolve(null)
  return bridge()!.autostart!.set!(enabled).then(
    (v) => (typeof v === 'boolean' ? v : null),
    () => null,
  )
}
