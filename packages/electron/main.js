// packages/electron/main.js — RoboJex desktop shell (main process, CommonJS).
//
// Responsibilities:
//   - single-instance lock + focus-forwarding for the second instance
//   - window state persistence (userData/window-state.json) with display-bounds
//     validation so a window saved on a now-detached monitor never comes back
//     off-screen
//   - main window + Alt+Space quick-ask widget window (frameless, always on
//     top, hides on blur)
//   - tray (programmatic 16x16 gradient icon, zero new deps): show/hide, new
//     chat, 5-gear quick switch, quit
//   - global shortcuts: Alt+Space widget, Ctrl+Shift+J main window
//   - Chinese native menu (required on macOS, set on all platforms)
//   - embedded ceo-core boot (dynamic import of the ESM dist) with graceful
//     degradation: ROBOJEX_EXTERNAL=1 or a busy :7620 skips embed; import
//     failure notifies the renderer via 'robojex:backend-down'
//   - hardened renderer: sandbox + contextIsolation, deny-all permissions,
//     CSP header injection (prod only), external links to the browser,
//     navigation locked to app origins
//   - UI origin strategy: dev loads vite :5173 (proxy /api -> :7620); prod
//     loads the SAME web dist served by the embedded ApiServer
//     (http://127.0.0.1:<port>) so the app's same-origin relative /api calls
//     and WS both work — loadFile(file://) cannot serve them, and is kept
//     only as the offline fallback shell.

const {
  app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut,
  ipcMain, shell, session, screen, dialog, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const isDev = !app.isPackaged;
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
const DEFAULT_API_PORT = 7620;
const EXTERNAL_BACKEND = process.env.ROBOJEX_EXTERNAL === '1';
// local voice daemon (SPEC-VOICE): SenseVoice ASR + Kokoro TTS, fully offline
const VOICED_URL = process.env.VOICED_URL || 'http://127.0.0.1:7640';

app.setName('RoboJex');

/* ────────────────────────── runtime state ────────────────────────── */

/** @type {BrowserWindow | null} */ let mainWindow = null;
/** @type {BrowserWindow | null} */ let widgetWindow = null;
/** @type {BrowserWindow | null} */ let voiceWindow = null;
/** true while the voice pill is capturing (toggles on each Ctrl+Alt+V) */
let voiceRecording = false;
/** bumped on every dictation START: late results/hides from an older
 *  session are dropped instead of clobbering the live capture */
let voiceSession = 0;
/** true between "start pressed, page still loading" and did-finish-load:
 *  a second press in that window cancels the queued start */
let voiceStartQueued = false;
/** true once the user actually asked to quit (tray mode intercepts closes) */
let isQuitting = false;
/** set while the before-quit shutdown hook re-enters app.quit() */
let coreStopped = false;

/** UI origin (prod): the embedded ApiServer origin once resolved; null means
 *  the file:// fallback shell (backend down). Dev always uses vite :5173. */
let uiBase = null;
/** action queued for a window that was still loading when it was triggered */
let pendingAction = null;

const backend = {
  /** 'booting' | 'up' | 'external' | 'down' */
  status: 'booting',
  /** embedded handle: { loop, api, stop } from ceo-core assembleAndStart */
  handle: null,
  port: DEFAULT_API_PORT,
};

// 5-gear autonomy model (mirrors SPEC-DESKTOP 2.2; renderer owns the truth,
// tray radios are a quick-switch affordance, balanced checked by default).
const GEARS = [
  { id: 0, label: '休眠 dormant' },
  { id: 1, label: '省电 eco' },
  { id: 2, label: '均衡 balanced' },
  { id: 3, label: '专注 focused' },
  { id: 4, label: '狂暴 turbo' },
];

/* ─────────────────────── single instance lock ─────────────────────── */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

app.on('second-instance', () => {
  // someone launched a second copy: surface our window instead
  focusMainWindow();
});

/* ────────────────────── window state persistence ────────────────────── */

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const st = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const x = num(st.x), y = num(st.y), w = num(st.width), h = num(st.height);
    if (w === null || h === null) return null;
    // default position (centered) when only the size was saved
    if (x === null || y === null) return { width: w, height: h, maximized: st.maximized === true };
    // a monitor from a previous session may be gone: keep the window only if
    // the saved rect still overlaps some display's work area by a sane margin
    const bounds = { x, y, width: w, height: h };
    const area = screen.getDisplayMatching(bounds).workArea;
    const overlaps =
      x < area.x + area.width - 80 &&
      y < area.y + area.height - 80 &&
      x + w > area.x + 80 &&
      y + h > area.y + 80;
    if (!overlaps) return null;
    return { x, y, width: w, height: h, maximized: st.maximized === true };
  } catch {
    return null;
  }
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const st = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(st, null, 2));
  } catch { /* best-effort: a lost geometry save must never break quitting */ }
}

/* ───────────────────────────── security ───────────────────────────── */

const CSP = [
  "default-src 'self'",
  // same-origin API + loopback gateways; ws: for the events socket
  "connect-src 'self' ws: http://127.0.0.1:* http://localhost:*",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'", // vite injects a small style blob
  "script-src 'self'",
  "font-src 'self'",
].join('; ');

function applySecurityPolicy() {
  const ses = session.defaultSession;
  // deny every permission request (notifications, geolocation, ...) except
  // the microphone, and only for the voice pill's own page
  const isVoicePage = (wc) => {
    try { return !!wc && !!voiceWindow && !voiceWindow.isDestroyed() && wc.id === voiceWindow.webContents.id; }
    catch { return false; }
  };
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' && isVoicePage(wc)) return callback(true);
    callback(false);
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && isVoicePage(wc));
  if (!isDev) {
    // CSP on prod responses; dev is excluded (vite HMR needs loose defaults)
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP],
        },
      });
    });
  }
}

/** True for URLs the app itself may navigate to (dev server, embedded API,
 *  its own file:// shell). Everything else is external. */
function isAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      return isDev ? false : u.pathname.startsWith(path.dirname(PRELOAD_PATH).replace(/\\/g, '/'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isDev) return u.origin === 'http://localhost:5173';
    const host = u.hostname;
    return (host === '127.0.0.1' || host === 'localhost') && String(backend.port) === u.port;
  } catch {
    return false;
  }
}

function hardenWebContents(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'deny' }; // no popups, not even ours
    void shell.openExternal(url); // target=_blank etc -> default browser
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(url);
  });
  // no <webview> is used; if one ever appears, keep it sandboxed
  wc.on('will-attach-webview', (event, webPreferences, params) => {
    event.preventDefault();
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    void params; // webviews are denied outright by the preventDefault above
  });
}

/* ──────────────────────── windows ──────────────────────── */

function prodIndexHtml() {
  // packaged layout: web dist is mapped into the asar root as web/
  return path.join(__dirname, 'web', 'index.html');
}

/** Resolve what the main window should load. Dev: vite. Prod: the embedded
 *  ApiServer origin serving the same web dist (same-origin /api + WS work
 *  there); file:// only when the backend never came up (offline shell). */
function mainLoadTarget() {
  if (isDev) return { url: 'http://localhost:5173' };
  if (uiBase) return { url: uiBase };
  return { file: prodIndexHtml() };
}

function baseWindowOptions(extra) {
  return {
    backgroundColor: '#0d0e12', // dark shell before first paint: no white flash
    show: false, // shown on ready-to-show: no gray flash
    ...extra,
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}

function wireWindowEvents(win) {
  const send = (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  win.on('maximize', () => send('robojex:maximized-changed', true));
  win.on('unmaximize', () => send('robojex:maximized-changed', false));
  hardenWebContents(win.webContents);
}

function createMainWindow() {
  const st = loadWindowState();
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
  mainWindow = new BrowserWindow(baseWindowOptions({
    title: 'RoboJex',
    width: st?.width ?? 1280,
    height: st?.height ?? 800,
    x: st?.x,
    y: st?.y,
    minWidth: 940,
    minHeight: 600,
    ...(icon ? { icon } : {}),
  }));
  if (st?.maximized) mainWindow.maximize();
  wireWindowEvents(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);
    // tray mode: closing hides to tray instead of quitting (not on macOS,
    // where closing to the dock is the native idiom)
    if (!isQuitting && tray && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  const target = mainLoadTarget();
  if (target.url) mainWindow.loadURL(target.url);
  else mainWindow.loadFile(target.file);

  // surface a backend failure that happened before this window existed
  if (backend.status === 'down') notifyBackendDown();
  return mainWindow;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    if (tray && process.platform !== 'darwin') mainWindow.hide();
    else mainWindow.minimize();
    return;
  }
  focusMainWindow();
}

/* widget: Alt+Space quick-ask mini console at /widget (WidgetApp) */
function createWidgetWindow() {
  widgetWindow = new BrowserWindow(baseWindowOptions({
    width: 360,
    height: 480,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
  }));
  wireWindowEvents(widgetWindow);
  widgetWindow.on('blur', () => widgetWindow?.hide()); // dismiss on focus loss
  widgetWindow.on('closed', () => { widgetWindow = null; });

  if (isDev) widgetWindow.loadURL('http://localhost:5173/widget');
  else if (uiBase) widgetWindow.loadURL(`${uiBase}/widget`);
  else widgetWindow.loadFile(prodIndexHtml()); // degraded: full app in a mini frame
  return widgetWindow;
}

function toggleWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    if (widgetWindow.isVisible()) widgetWindow.hide();
    else {
      placeWidgetNearCursor();
      widgetWindow.show();
      widgetWindow.focus();
    }
    return;
  }
  createWidgetWindow();
  placeWidgetNearCursor();
  widgetWindow.once('ready-to-show', () => widgetWindow?.show());
}

function placeWidgetNearCursor() {
  if (!widgetWindow) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [w, h] = widgetWindow.getSize();
  widgetWindow.setPosition(
    Math.round(workArea.x + (workArea.width - w) / 2),
    Math.round(workArea.y + Math.min(120, workArea.height * 0.12)),
  );
}

/* ───────────────────────── voice pill ───────────────────────── */
/* Ctrl+Alt+V toggles a small always-on-top pill (voice.html) that records
 * 16 kHz mono PCM in-page. On stop the WAV rides IPC here, main does BOTH
 * network hops (voiced /asr → ceo-core /api/chat) so the pill never needs
 * CORS or the backend port, then dismisses itself. Ctrl+Alt+R asks the main
 * renderer to speak the latest jex reply (voice-readback action). */

function createVoiceWindow() {
  voiceWindow = new BrowserWindow(baseWindowOptions({
    width: 300,
    height: 64,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true, // must take focus so blur-to-stop stays possible later
  }));
  voiceWindow.setAlwaysOnTop(true, 'screen-saver');
  // static page in both dev and prod: __dirname/voice.html (asar keeps it)
  voiceWindow.loadFile(path.join(__dirname, 'voice.html'));
  voiceWindow.on('closed', () => { voiceWindow = null; voiceRecording = false; });
  voiceWindow.once('ready-to-show', () => {
    placeVoicePill();
    voiceWindow?.show();
  });
  return voiceWindow;
}

function placeVoicePill() {
  if (!voiceWindow) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = voiceWindow.getSize();
  voiceWindow.setPosition(
    Math.round(workArea.x + (workArea.width - w) / 2),
    Math.round(workArea.y + workArea.height - h - 96),
  );
}

function voiceState(st) {
  if (voiceWindow && !voiceWindow.isDestroyed()) voiceWindow.webContents.send('voice:state', st);
}

function hideVoicePillSoon(ms = 1400, session = voiceSession) {
  setTimeout(() => {
    // a newer dictation owns the pill now: a late hide from the previous
    // session must not dismiss it mid-capture nor clobber the flag
    if (session !== voiceSession) return;
    if (voiceWindow && !voiceWindow.isDestroyed()) voiceWindow.hide();
    voiceRecording = false;
  }, ms);
}

async function toggleVoiceTalk() {
  if (voiceRecording) { // second press: stop capture, WAV arrives via IPC
    voiceRecording = false;
    // the page may STILL be loading (first press just created the window):
    // a 'stop' sent now lands on a page without listeners and is dropped —
    // cancel the queued start instead, the capture never began
    if (voiceStartQueued) { voiceStartQueued = false; return; }
    voiceState('stop');
    return;
  }
  voiceRecording = true;
  voiceSession++; // new dictation: invalidates late results/hides of the old one
  if (!voiceWindow || voiceWindow.isDestroyed()) {
    createVoiceWindow();
    voiceStartQueued = true;
    // start once the page has its preload listeners up
    voiceWindow?.webContents.once('did-finish-load', () => {
      voiceStartQueued = false;
      if (voiceRecording) voiceState('start');
      else hideVoicePillSoon(200); // cancelled while loading: nothing to stop
    });
    return;
  }
  voiceWindow.show();
  voiceWindow.focus();
  placeVoicePill();
  voiceState('start');
}

/** voiced /asr → ceo-core /api/chat. Runs in main: no CORS, no port leaks. */
async function transcribeAndSend(wav) {
  const session = voiceSession;
  const pill = (st, hide) => {
    if (session !== voiceSession) return; // stale: a newer dictation took over
    voiceState(st);
    if (hide) hideVoicePillSoon(1400, session);
  };
  try {
    const r = await fetch(`${VOICED_URL}/asr`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`voiced /asr ${r.status}`);
    const { text } = await r.json();
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return pill('empty', true);
    const cr = await fetch(`http://127.0.0.1:${backend.port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!cr.ok) throw new Error(`/api/chat ${cr.status}`);
    pill('sent', true);
  } catch (err) {
    console.warn('[robojex] voice talk 失败：', err instanceof Error ? err.message : err);
    pill('err', true);
  }
}

/* ─────────────────────── tray ─────────────────────── */

// 16x16 purple->cyan rounded gradient, generated at build time with zlib
// (scripts note: /tmp generator, no runtime dependency). Embedded so the
// tray works from a bare checkout with zero binary assets.
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABu0lEQVR42o3T3UvTARTG8fMXBUIYROGPoixKLbO0sjK1NDXfQ3Em1sLKF4qpMBwkuCCYF8K8ENbFj9aV3rm7dad33rXU5nTrG4+4yHKbf8CH5znncCw0igVe4kx4cId6oLMtw9PONC29aZr692gc3OXh8C73X6W4+yZFzfgON9/vuJVTSafCn7R9/NEH06Pw2gv9HgphKqeSVPiTXA38dEzJwh9m4J0PXoxBt5fjYC7Pbrum2koW9s/B2xnwTELbGIUwF4PbmGZWbSUL+0LgnYNnAXg8SV58/tMWll2YaitZeDwMz0PQEYS6ADmxM7+F/b0w1Vay8EgE+sLwZB7uBDkSn13YxP7dtmorWXg4Cl0RaAhDVYj/8OnFTeyobau2koUHlqH1C9yLQHmYQ/jU0g8s16lUW8nCvavwaBmqo3Ap8usPPvk5geU7lWorWbg9Dg9W4foKnItm9nGRm8AK3Vm1lSzcvAa343AlBmdW0pz4+h0rdGfNrNpKFq7fgBtrcOEbFMf2sIPHyImzC1NtJQvXJqBsA0rWce3gq/Li7MJUW8nCt1JQmsAxvaS+So+RD2thmlm1lSx8Dew3IWjocbg/jZAAAAAASUVORK5CYII=';

function sendAction(type, payload = {}) {
  // tray/menu actions ride one channel; the renderer's onAction() fans out
  let createdFresh = false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow(); // darwin closed-window path: recreate, then deliver
    createdFresh = true;
  }
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  const action = { type, ...payload };
  if (createdFresh && mainWindow) {
    // the page is still loading: the renderer's listener isn't up yet, so
    // stash the action and flush once the document finished loading
    pendingAction = action;
    mainWindow.webContents.once('did-finish-load', () => {
      if (!pendingAction || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('robojex:action', pendingAction);
      pendingAction = null;
    });
    return;
  }
  mainWindow?.webContents.send('robojex:action', action);
}

function buildTrayMenu() {
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  return Menu.buildFromTemplate([
    { label: visible ? '隐藏主窗口' : '显示主窗口', click: () => toggleMainWindow() },
    { type: 'separator' },
    { label: '新对话', click: () => sendAction('new-chat') },
    {
      label: '挡位',
      submenu: GEARS.map((g) => ({
        label: g.label,
        type: 'radio',
        checked: g.id === 2,
        click: () => sendAction('set-gear', { gear: g.id }),
      })),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  try {
    // brand-consistent: real app icon scaled down when present, embedded
    // gradient as the bare-checkout fallback
    let img;
    const iconPath = path.join(__dirname, 'icon.png');
    if (fs.existsSync(iconPath)) {
      img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    }
    if (!img || img.isEmpty()) {
      img = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`);
    }
    if (img.isEmpty()) throw new Error('tray image decode failed');
    tray = new Tray(img);
    tray.setToolTip('RoboJex');
    tray.setContextMenu(buildTrayMenu());
    // click behaves like the menu's first item on non-mac platforms
    if (process.platform !== 'darwin') tray.on('click', () => toggleMainWindow());
  } catch (err) {
    // no tray (headless, missing indicator libs): app must still run, and
    // closing the window then quits instead of hiding into nowhere
    console.warn('[robojex] tray unavailable:', err instanceof Error ? err.message : err);
    tray = null;
  }
}

/* ──────────────────── native menu (Chinese) ──────────────────── */

function showAbout() {
  void dialog.showMessageBox({
    type: 'info',
    title: '关于 RoboJex',
    message: 'RoboJex',
    detail: [
      `Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · Node ${process.versions.node}`,
      `后端状态：${backend.status}${backend.status === 'up' ? ` (127.0.0.1:${backend.port})` : ''}`,
      isDev ? '开发模式（vite :5173）' : '生产构建',
    ].join('\n'),
  });
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function setupAppMenu() {
  const focused = () => BrowserWindow.getFocusedWindow();
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: 'RoboJex',
          submenu: [
            { label: '关于 RoboJex', click: showAbout },
            { type: 'separator' },
            { role: 'services', label: '服务' },
            { type: 'separator' },
            { role: 'hide', label: '隐藏' },
            { role: 'hideOthers', label: '隐藏其他' },
            { role: 'unhide', label: '全部显示' },
            { type: 'separator' },
            { label: '退出', accelerator: 'CmdOrCtrl+Q', click: quitApp },
          ],
        }]
      : []),
    {
      label: '文件',
      submenu: [
        { label: '新对话', accelerator: 'CmdOrCtrl+N', click: () => sendAction('new-chat') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: quitApp },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '重载',
          accelerator: 'F5',
          click: () => { const w = focused(); if (w) w.reload(); },
        },
        {
          label: '开发者工具',
          accelerator: isDev ? 'F12' : 'CmdOrCtrl+Shift+I',
          click: () => { const w = focused(); if (w) w.toggleDevTools(); },
        },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { role: 'close', label: '关闭' },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 RoboJex', click: showAbout }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ─────────────────── global shortcuts ─────────────────── */

function registerShortcuts() {
  const ok1 = globalShortcut.register('Alt+Space', () => toggleWidget());
  if (!ok1) console.warn('[robojex] Alt+Space 注册失败（可能被其他应用占用）');
  const ok2 = globalShortcut.register('Ctrl+Shift+J', () => focusMainWindow());
  if (!ok2) console.warn('[robojex] Ctrl+Shift+J 注册失败（可能被其他应用占用）');
  const ok3 = globalShortcut.register('Ctrl+Alt+V', () => { void toggleVoiceTalk(); });
  if (!ok3) console.warn('[robojex] Ctrl+Alt+V 注册失败（可能被其他应用占用）');
  const ok4 = globalShortcut.register('Ctrl+Alt+R', () => sendAction('voice-readback'));
  if (!ok4) console.warn('[robojex] Ctrl+Alt+R 注册失败（可能被其他应用占用）');
}

/* ─────────────────── voiced sidecar (SPEC-VOICE) ───────────────────
 * The voice daemon is a plain node process: dev runs the repo checkout,
 * the packaged app ships packages/voiced/src + sherpa-onnx-node next to the
 * asar (unpacked — native .node binaries) and %APPDATA% holds the 2GB model
 * trees. Boot order: probe :7640; if nothing answers and a local voiced
 * tree exists, spawn it detached and bound-wait; a probeable external
 * daemon (e.g. the WSL one) wins without a fight. Failure is silent except
 * a one-line log — the pill's err state is the user-facing surface. */

const voicedRuntime = {
  /** @type {import('child_process').ChildProcess | null} */
  proc: null,
  spawned: false,
};

function voicedHealthUrl() {
  return `${VOICED_URL}/health`;
}

function probeVoiced(timeoutMs = 800) {
  return fetch(voicedHealthUrl(), { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

function voicedSidecarCandidates() {
  // dev: the repo checkout next to this package. prod: the UNPACKED copy
  // first — the native sherpa-onnx .node cannot dlopen from inside an asar,
  // so electron-builder unpacks voiced + its runtime there.
  const dirs = [];
  if (isDev) dirs.push(path.join(__dirname, '..', 'voiced'));
  dirs.push(path.join(__dirname, '..', 'app.asar.unpacked', 'voiced'));
  dirs.push(path.join(__dirname, 'voiced')); // non-asar layouts
  return dirs.filter((d) => fs.existsSync(path.join(d, 'src', 'index.mjs')));
}

function modelsDirFor(dir) {
  if (isDev) return path.join(dir, 'models'); // repo keeps models beside source
  return path.join(app.getPath('userData'), 'voiced-models'); // %APPDATA%/RoboJex
}

async function ensureVoiced() {
  if (await probeVoiced()) {
    console.log('[robojex] voiced 已在运行（外部实例）');
    return;
  }
  const cand = voicedSidecarCandidates();
  if (cand.length === 0) {
    console.warn('[robojex] 未找到 voiced sidecar 源码目录 — 语音功能依赖外部 :7640 服务');
    return;
  }
  const dir = cand[0];
  const modelsDir = modelsDirFor(dir);
  voicedRuntime.spawned = true;
  try {
    voicedRuntime.proc = spawn(process.execPath, [
      path.join(dir, 'src', 'index.mjs'), '--models', modelsDir,
    ], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // execPath is Electron
    });
    voicedRuntime.proc.unref();
    const up = await waitForUrl(voicedHealthUrl(), 8_000);
    console.log(up ? `[robojex] voiced sidecar 已启动（models: ${modelsDir}）` : '[robojex] voiced sidecar 启动超时（模型缺失？）');
  } catch (err) {
    console.warn('[robojex] voiced sidecar 启动失败：', err instanceof Error ? err.message : err);
  }
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeVoiced(500)) return true; // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300)); // eslint-disable-line no-await-in-loop
  }
  return false;
}

/** Download the ~2GB model trees into the sidecar's models dir (settings ›
 *  聊天 › 语音汇报 下载按钮). Resolves { ok, log } — the renderer toasts. */
async function downloadVoiceModels() {
  const cand = voicedSidecarCandidates();
  if (cand.length === 0) return { ok: false, log: 'voiced sidecar 目录缺失' };
  // packaged: scripts/download-voice-models.mjs mapped into the app root;
  // dev: the repo's scripts/ next to packages/
  const scriptPaths = [
    path.join(__dirname, 'scripts', 'download-voice-models.mjs'),
    path.join(__dirname, '..', '..', 'scripts', 'download-voice-models.mjs'),
  ];
  const script = scriptPaths.find((p) => fs.existsSync(p));
  if (!script) return { ok: false, log: '下载脚本缺失' };
  const dir = modelsDirFor(cand[0]);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, dir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let tail = '';
    const keep = (d) => { tail = (tail + String(d)).slice(-1_500); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => resolve({ ok: false, log: String(e) }));
    child.on('close', (code) => {
      void ensureVoiced(); // models may have just landed — bring the daemon up
      resolve({ ok: code === 0, log: tail || `exit ${code}` });
    });
  });
}

/* ─────────────────── embedded ceo-core ─────────────────── */

function resolveRuntimeDir() {
  if (process.env.ROBOJEX_RUNTIME) return process.env.ROBOJEX_RUNTIME;
  // dev: the repo runtime/ the CLI jexd already uses; prod: per-user data
  return isDev
    ? path.join(__dirname, '..', '..', 'runtime')
    : path.join(app.getPath('userData'), 'runtime');
}

/** ceo-core ESM dist candidates: asar path first, then the unpacked copy. */
function coreEntryCandidates() {
  if (isDev) return [path.join(__dirname, '..', 'ceo-core', 'dist', 'index.js')];
  return [
    path.join(__dirname, 'core', 'dist', 'index.js'),
    path.join(__dirname, '..', 'app.asar.unpacked', 'core', 'dist', 'index.js'),
  ];
}

function probePort(port) {
  return new Promise((resolve) => {
    // NOTE: no bare net.connect here — on hosts where closed loopback ports
    // drop SYNs instead of RSTing (WSL2 mirrored networking does), a connect
    // hangs for the full TCP retry window. A local listener accepts in
    // single-digit ms, so anything past 800ms counts as "not listening".
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (up) => { s.destroy(); resolve(up); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true; // eslint-disable-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100)); // eslint-disable-line no-await-in-loop
  }
  return false;
}

function notifyBackendDown() {
  const message = '内嵌 ceo-core 启动失败，UI 以离线模式运行';
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('robojex:backend-down', { message });
}

async function bootBackend() {
  if (EXTERNAL_BACKEND) {
    backend.status = 'external';
    backend.port = Number(process.env.ROBOJEX_API_PORT) || DEFAULT_API_PORT;
    console.warn('[robojex] ROBOJEX_EXTERNAL=1：跳过内嵌后端，使用外部 ceo-core');
    return;
  }

  const runtimeDir = resolveRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  process.env.ROBOJEX_RUNTIME = runtimeDir; // children + core agree on one dir
  if (!isDev) process.env.ROBOJEX_WEB_DIR = path.join(__dirname, 'web');

  // read apiPort from the same config.json jexd uses, so the UI origin port
  // matches even for non-default ports
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'config.json'), 'utf8'));
  } catch { /* fresh install: defaults apply */ }
  const cfgPort = Number(cfg.apiPort) || DEFAULT_API_PORT;

  // a jexd (or a previous app instance's core) already owns the port: embed
  // would double-run the loop against the same board — treat it as external
  if (await probePort(cfgPort)) {
    backend.status = 'external';
    backend.port = cfgPort;
    console.warn(`[robojex] :${cfgPort} 已被占用，按外部 ceo-core 处理`);
    return;
  }

  try {
    let mod = null;
    let lastErr = null;
    for (const p of coreEntryCandidates()) {
      if (!fs.existsSync(p)) continue;
      mod = await import(pathToFileURL(p).href); // eslint-disable-line no-await-in-loop
      break;
    }
    if (!mod) throw lastErr ?? new Error('ceo-core dist 未找到（先运行 npm run build）');

    mod.seedRuntimeFiles?.(runtimeDir);
    mod.initRuntimeGit?.(runtimeDir);
    // neutralize stop()'s process.exit: in-process embedding must let the
    // Electron quit flow finish (window teardown, state save) cleanly
    const handle = mod.assembleAndStart(cfg, runtimeDir, { exit: () => {} });
    backend.handle = handle;
    backend.port = handle.api?.port || cfgPort;
    // api.start() is async inside assembleAndStart: wait for the listener
    const up = await waitForPort(backend.port, 6_000);
    if (!up) throw new Error(`API 端口 ${backend.port} 未在 6s 内就绪`);
    backend.status = 'up';
    console.log(`[robojex] 内嵌 ceo-core 运行于 http://127.0.0.1:${backend.port}`);
  } catch (err) {
    backend.handle = null;
    // port came up anyway (external core racing us): use it, else degrade
    if (await probePort(backend.port)) {
      backend.status = 'external';
      return;
    }
    backend.status = 'down';
    console.warn('[robojex] 内嵌 ceo-core 启动失败：', err instanceof Error ? err.stack ?? err.message : err);
    notifyBackendDown();
  }
}

/** Prod UI origin — the embedded/external ApiServer serving the web dist. */
async function resolveUiBase() {
  if (isDev) return 'http://localhost:5173';
  const ok = backend.status === 'up' || backend.status === 'external' || await waitForPort(backend.port, 2_000);
  return ok ? `http://127.0.0.1:${backend.port}` : null;
}

/* ─────────────────── IPC surface ─────────────────── */

function registerIpc() {
  const from = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('window:minimize', (e) => { from(e)?.minimize(); });
  ipcMain.handle('window:maximize', (e) => {
    const w = from(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize(); // toggle
  });
  ipcMain.handle('window:close', (e) => { from(e)?.close(); });
  ipcMain.handle('window:is-maximized', (e) => from(e)?.isMaximized() ?? false);
  // butler briefings as native toasts — dispatched by the renderer when a
  // jex report lands outside the open conversation or the app is hidden;
  // clicking the toast recalls the window that raised it
  ipcMain.handle('notify', (e, payload) => {
    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    if (!title || !Notification.isSupported()) return false;
    const w = from(e);
    const n = new Notification({
      title: title.slice(0, 120),
      body: typeof payload?.body === 'string' ? payload.body.slice(0, 300) : '',
    });
    n.on('click', () => { if (w?.isMinimized()) w.restore(); w?.show(); w?.focus(); });
    n.show();
    return true;
  });

  // voice pill: finished WAV → voiced /asr → ceo-core /api/chat
  ipcMain.on('voice:clip', (_e, wav) => {
    if (!(wav instanceof ArrayBuffer) || wav.byteLength < 44 + 3200) { // <0.1s guard, renderer double-checks
      voiceState('empty');
      hideVoicePillSoon(600);
      return;
    }
    void transcribeAndSend(Buffer.from(wav));
  });
  // pill-side terminal events (mic denied / clip too short): let it settle, then hide
  ipcMain.on('voice:event', (_e, kind) => {
    if (kind === 'mic-denied' || kind === 'too-short') {
      voiceRecording = false;
      hideVoicePillSoon(1800);
    }
  });
  // settings › 聊天 › 语音汇报: fetch the ~2GB model trees (long-running; the
  // renderer polls /health to flip the card to ready)
  ipcMain.handle('voice:download-models', () => downloadVoiceModels());
}

/* ─────────────────── app lifecycle ─────────────────── */

app.on('before-quit', (event) => {
  // mark first: every close handler must let real quit paths (menu, tray,
  // SIGTERM from a supervisor) through instead of hiding to tray
  isQuitting = true;
  // give the embedded core one synchronous, orderly stop (loop halted,
  // sub-agents killed, api closed) before the process goes away
  if (!coreStopped && backend.handle) {
    event.preventDefault();
    coreStopped = true;
    try { backend.handle.stop(); } catch (err) { console.warn('[robojex] core stop 异常：', err); }
    app.quit(); // re-enter; the flag now lets the quit proceed
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy(); // release the indicator before the process goes away
  // the voice sidecar is detached; take it with us when we spawned it
  if (voicedRuntime.proc && !voicedRuntime.proc.killed) {
    try { voicedRuntime.proc.kill(); } catch { /* already gone */ }
  }
});

app.on('window-all-closed', () => {
  // close-to-tray intercepts the close event, so this only fires on real
  // quit paths or window close without a tray (or on darwin, where the app
  // natively stays alive with all windows closed)
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => { // macOS dock click
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else focusMainWindow();
});

app.whenReady().then(async () => {
  applySecurityPolicy();
  setupAppMenu();
  registerIpc();

  if (isDev) {
    // dev: window first (vite is already up), core embeds in parallel — the
    // dev proxy buffers /api until the port answers
    createMainWindow();
    createTray();
    registerShortcuts();
    await bootBackend();
  } else {
    // prod: bound-wait for the core so the window loads the real origin
    // instead of a file shell that would immediately need a reload
    await bootBackend();
    uiBase = await resolveUiBase();
    createMainWindow();
    createTray();
    registerShortcuts();
    if (backend.status === 'down') notifyBackendDown();
  }
  void ensureVoiced(); // voice daemon: never blocks first paint
}).catch((err) => {
  console.error('[robojex] 启动失败：', err);
  app.quit();
});

} // single-instance guard
