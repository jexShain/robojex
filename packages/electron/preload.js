// packages/electron/preload.js — sandboxed contextBridge surface.
//
// Runs with sandbox:true, where preload is limited to the electron/ipcRenderer
// subset — contextBridge + ipcRenderer are exactly what this file needs.
//
// Exposes window.robojex:
//   platform                       process.platform ('win32'|'linux'|'darwin')
//   versions                       { electron, chrome, node }
//   window.{minimize,maximizeToggle,close,isMaximized}
//   window.onMaximizedChanged(cb)  -> unsubscribe fn
//   onAction(cb)                   {type:'new-chat'} | {type:'set-gear', gear}
//                                  -> unsubscribe fn (tray + menu actions)
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
  },

  // one unified subscription for tray / native-menu actions
  onAction: (cb) => subscribe('robojex:action', cb),

  // embedded ceo-core failed to boot; payload: { message }
  onBackendDown: (cb) => subscribe('robojex:backend-down', cb),

  // extension slots (intentional no-ops until the frame layer claims them)
  collapseSidebar: () => {},
  callout: (_message) => {},
});
