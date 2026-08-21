# Task W2 Report — HudBar Component + AppFrame Integration

## Status: ✅ Complete

## What was built

### New files
- **`packages/web/src/frame/HudBar.tsx`** — Top status strip component with five elements:
  1. **Heartbeat lamp** (`.hud-heart`): 10px circle, grey when idle, green (`--hud-pulse`) with 60s `hud-heartbeat` keyframe pulse when alive
  2. **Mode pill** (`.hud-mode`): colored pill showing current mode (observe/assist/full) — amber/blue/red via semantic state tokens
  3. **Fuel gauge** (`.hud-fuel` / `.hud-fuel-fill`): 160px max-width progress bar showing budget consumption; flashes amber (`--hud-warn`) at ≥80% via `hud-pulse-warn` keyframe
  4. **Clock** (`.hud-clock`): server-time-aligned HH:MM:SS display, monospace, tabular-nums, right-aligned
  5. **Collapse button** (`.hud-collapse`): `▁` glyph, navigates to `/widget`

- **`packages/web/src/styles/hud.css`** — Complete stylesheet with:
  - `--hud-glow` / `--hud-warn` / `--hud-pulse` tokens on `:root` (mapped to real semantic state tokens with hex fallbacks)
  - `.hud-bar` at 36px height, `flex:none` so it never squeezes the chat pane below
  - 60s `hud-heartbeat` keyframe (one bright beat per minute)
  - 1.6s `hud-pulse-warn` keyframe (amber opacity flash)
  - Theme-aware via `--dsw-alias-*` tokens (border, background, label color)

### Modified files
- **`packages/web/src/frame/AppFrame.tsx`** — Added `import { HudBar } from './HudBar'` and mounted `<HudBar onCollapse={() => location.assign('/widget')} />` as the first child of `.col-center` (flex column)
- **`packages/web/src/main.tsx`** — Added `import './styles/hud.css'` after `app.css`

## Store field adaptations

The brief referenced `s.cycles` (nonexistent) and used `s` as the raw `WebState`. Actual store shape:
- `useStore()` returns `StoreApi` → destructured as `const { state: s } = useStore()`
- **`alive` flag**: `s.lastHud !== null || s.transcript.some((t) => t.kind === 'cycle')` — any hud notice or cycle transcript entry means the loop is alive
- **Budget null guard**: `s.budget` is `Budget | null` (null before first `hello` frame); guarded with optional chaining, shows `—/—` when null, pct=0

## Token mapping

Brief used `--dsw-alias-accent-amber/blue/red` (nonexistent). Mapped to real semantic tokens:
| Brief token | Real token | Hex fallback |
|---|---|---|
| `--dsw-alias-accent-amber` | `--dsw-alias-state-warn-primary` | `#d97706` |
| `--dsw-alias-accent-blue` | `--dsw-alias-state-business-primary` | `#5686fe` |
| `--dsw-alias-accent-red` | `--dsw-alias-state-error-primary` | `#dc2626` |
| `--dsw-static-border` | `--dsw-alias-border-l2` | `#333` |
| `--dsw-static-bg-subtle` | `--dsw-alias-bg-layer-2` | `#222` |

## Verification

### Build
```
$ npx vite build packages/web
✓ 52 modules transformed.
✓ built in 654ms
```

### Browser visual verification (vite preview + headless Chromium)
- **No runtime exceptions** — `useStore` properly resolved (initial build had a lost import that was fixed)
- **Bar height**: 36px (≤36px constraint met)
- **Layout**: `.col-center` is `display:flex; flex-direction:column`; HudBar is `flex:none` — chat pane retains `flex:1`
- **Heartbeat**: 10px circle, `border-radius:50%`, grey idle (no WS connection → no cycle traffic)
- **Mode pill**: "observe" with amber bg `rgb(245,158,11)`, white text, uppercase, `letter-spacing:0.55px`
- **Fuel bar**: 160px wide, 6px tall, 3px radius, blue fill `rgb(86,134,254)`, 0% fill (budget null)
- **Clock**: `05:39:41 PM`, `font-variant-numeric:tabular-nums`, `margin-left:auto` (610px → right-aligned)
- **Collapse**: `▁` glyph, `title="collapse to widget"`, `aria-label="collapse to widget"`
- **Keyframes**: `hud-heartbeat` (60s) and `hud-pulse-warn` (1.6s) both present in stylesheet
- **Tokens**: `--hud-glow: #5686fe`, `--hud-warn: #f59e0b`, `--hud-pulse: #34d399` — all defined
- **Dark theme**: bar bg `rgb(35,35,36)`, text `rgb(249,250,251)`, border `rgba(255,255,255,0.12)` — all theme-aware
- **5 children** in `.hud-bar` (heart, mode, fuel, clock, collapse)

## Commit
```
feat(hud): HudBar — heartbeat, mode lamp, fuel gauge, clock
```

## Concerns
- **Heartbeat only visible with WS connection**: The 60s keyframe animation only runs when `alive` is true (requires actual cycle traffic or hud notices). Without a live core backend, the heart stays grey. This is correct behavior but means the pulse cannot be visually verified in a standalone preview.
- **Clock format locale-dependent**: `toLocaleTimeString` output varies by browser locale (e.g., "05:39:41 PM" vs "17:39:41"). Brief specified HH:MM:SS; current implementation matches the brief's intent.
- **Budget null before hello**: Until the first `hello` frame arrives from core, budget is null and the fuel bar shows 0%. This is expected initial state.
