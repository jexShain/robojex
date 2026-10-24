// packages/electron/preload.js — sandboxed contextBridge surface.
//
// Runs with sandbox:true, where preload is limited to the electron/ipcRenderer
// subset — contextBridge + ipcRenderer are exactly what this file needs.
//
// Exposes window.robojex:
//   platform                       process.platform ('win32'|'linux'|'darwin')
//   versions                       { electron, chrome, node }
//   window.{minimize,maximizeToggle,close,isMaximized}
//   window.{setOntop,isOntop}      widget-mode pin (T8), resolves OS truth
//   window.onMaximizedChanged(cb)  -> unsubscribe fn
//   onAction(cb)                   {type:'new-chat'} | {type:'set-gear', gear}
//                                  | {type:'voice-readback'}  (Ctrl+Alt+R)
//                                  -> unsubscribe fn (tray + menu actions)
//   voice.{onState,sendClip,event} voice pill IPC (voice.html only)
//   onBackendDown(cb)              embedded core failed; UI is offline
//   collapseSidebar()/callout()    no-op extension slots for the frame layer

const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to a main->renderer push channel; returns an unsubscribe fn so
 *  React effects can clean up without leaking listeners across reloads. */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => {
    try { callback(payload); } catch (err) { console.error('[robojex preload]', err); }
  };
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

contextBridge.exposeInMainWorld('robojex', {
  platform: process.platform,
  // sandboxed preloads get a limited `process` surface; versions may be absent
  // on some Electron builds — degrade to 'unknown' rather than throw
  versions: {
    electron: process.versions?.electron ?? 'unknown',
    chrome: process.versions?.chrome ?? 'unknown',
    node: process.versions?.node ?? 'unknown',
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChanged: (cb) => subscribe('robojex:maximized-changed', cb),
    // widget mode (T8): pin above everything; resolves the post-write OS truth
    setOntop: (onTop) => ipcRenderer.invoke('window:set-ontop', !!onTop),
    isOntop: () => ipcRenderer.invoke('window:is-ontop'),
  },

  // one unified subscription for tray / native-menu actions
  onAction: (cb) => subscribe('robojex:action', cb),

  // butler briefing → native OS toast (main process routes + focuses on click)
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),

  // voice pill surface (voice.html only): main pushes capture start/stop and
  // transcribe outcomes; the page pushes back WAV clips and terminal events
  voice: {
    onState: (cb) => subscribe('voice:state', cb),
    sendClip: (wavArrayBuffer) => ipcRenderer.send('voice:clip', wavArrayBuffer),
    event: (kind) => ipcRenderer.send('voice:event', kind),
  },

  // settings › 聊天: fetch the ~2GB local voice model trees (sidecar boot
  // follows automatically); resolves { ok, log }
  downloadVoiceModels: () => ipcRenderer.invoke('voice:download-models'),

  // settings › 通用 › 开机自启 — main process owns the OS integration
  // (LoginItemSettings on win/mac, XDG autostart on linux); both calls
  // resolve to the post-read OS truth
  autostart: {
    get: () => ipcRenderer.invoke('autostart:get'),
    set: (enabled) => ipcRenderer.invoke('autostart:set', !!enabled),
  },

  // push { gear: 0..4, label, connected } to the tray tooltip + menu radios
  setTrayStatus: (payload) => ipcRenderer.send('tray:status', payload),

  // embedded ceo-core failed to boot; payload: { message }
  onBackendDown: (cb) => subscribe('robojex:backend-down', cb),

  // extension slots (intentional no-ops until the frame layer claims them)
  collapseSidebar: () => {},
  callout: (_message) => {},
});
