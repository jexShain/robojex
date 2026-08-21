# Task W4 Report — /widget desktop-widget mode

## Status
**Complete.** All acceptance criteria met and verified.

## Commit
`feat(widget): /widget desktop-widget mode — gantt band, rings, feed`

## What was built

### Files created
- `packages/web/src/widget/WidgetApp.tsx` — 400×600 mini console with three tabs
  (minute gantt band, progress-ring wall, event feed), 8s auto-rotation
  halted by pin, bidirectional navigation with the main console.
- `packages/web/src/widget/widget.css` — low-density 12px baseline styling;
  motion limited to the heartbeat lamp (reused from hud.css) and the gantt
  now-line (60s linear transition). Status tones: todo=gray, running=blue,
  done=green, blocked=red — all from existing semantic tokens.
- `packages/web/src/Providers.tsx` — shared `<Providers>` wrapper (theme +
  store) extracted so App and WidgetApp mount the identical provider stack
  without duplicating wiring.

### Files modified
- `packages/web/src/main.tsx` — routes `location.pathname === '/widget'` to
  `<WidgetAppRoot/>`, everything else to `<App/>`. Imports `widget.css`.
- `packages/web/src/App.tsx` — refactored to compose `<Providers>` instead
  of inlining `<StoreProvider>` + `useTheme()`.

### Store field alignment
The brief's skeleton used `s.tasks` / `s.transcript` etc. directly, but the
real `useStore()` returns `{ state, ... }`. The implementation reads
`const { state: s } = useStore()` and uses `s.tasks`, `s.transcript`,
`s.clockOffset`, `s.lastHud` — matching the actual `WebState` interface.
`TranscriptItem` is a discriminated union (`msg` | `cycle` | `toast`); the
feed renders `msg` (from+text), `cycle` (action count), and `toast` (text)
with per-kind CSS classes. Task `status` is a string; `st-${status}` maps to
the four board-v2 statuses. Ring `v-${verdict}` reuses the hud.css verdict
color classes (`v-pass` | `v-partial` | `v-fail` | `v-unchecked`).

## Verification

### Build
```
vite v6.4.3 building for production...
✓ 55 modules transformed.
dist/index.html                   1.17 kB │ gzip:  0.70 kB
dist/assets/index-*.css            63.67 kB │ gzip: 10.44 kB
dist/assets/index-*.js            201.41 kB │ gzip: 64.18 kB
✓ built in 660ms
```
Total gzip: **75.32 KB** (< 400 KB requirement). ✓

### Browser visual verification (vite dev + headless Chromium at /widget)
- **Layout**: 400×600 fixed viewport, 34px header with heartbeat lamp, three
  tab buttons (gantt/rings/feed), pin toggle (○/📌), expand button (⤢). ✓
- **Auto-rotate**: On load defaults to `gantt`; after 8s advances to `rings`
  → `feed` → `gantt`. ✓
- **Pin**: Clicking a tab selects it AND pins (aria-pressed=true, 📌 icon);
  auto-rotation stops (verified: stayed on `feed` for 10s while pinned).
  Clicking the pin button unpins (○, aria-pressed=false); auto-rotation
  resumes (verified: advanced after 8s). ✓
- **Gantt tab**: Renders the `.widget-gantt` band area with the now-line at
  50% (left ≈ 199px of 400px), `transition: left 60s linear`. Empty (no
  backend running) — correct empty state. ✓
- **Rings tab**: Renders `.widget-rings` with the idle state
  ("idle — jex is alive") when no running tasks. ✓
- **Feed tab**: Renders `.widget-feed` (empty, no transcript — correct). ✓
- **Console↔widget jump**: ⤢ expand button → navigates to `/` and renders
  `AppFrame` (full console). HudBar "collapse to widget" (▁) → navigates to
  `/widget` and renders `WidgetApp`. Bidirectional round-trip confirmed. ✓
- **Dark theme**: widget root/header backgrounds flip to dark neutral tokens;
  now-line renders blue (`--hud-glow` = deepseek-400). Tokens resolve
  correctly under `body[data-ds-dark-theme]`. ✓

### Type-check
`npx tsc --noEmit` reports 5 errors, **all pre-existing on the W3 commit**
(`3d1d384`) in `AppFrame.tsx`, `ActivityFeed.tsx`, `AgendaView.tsx` — none
in W4 files. Vite build (esbuild transpile) succeeds regardless. ✓

## Concerns
- **Pre-existing tsc errors** (5) in W3 files remain unaddressed; they do not
  block the build (vite uses esbuild) but should be cleaned up in a follow-up.
- **No live backend** during verification, so gantt bands/rings/feed render
  empty states. The rendering logic is verified structurally against the
  real store field shapes and the `TranscriptItem` discriminated union.
- **Pin auto-set on tab click**: per the brief, clicking a tab pins the view.
  The pin button toggles pin independently. Both paths verified.
