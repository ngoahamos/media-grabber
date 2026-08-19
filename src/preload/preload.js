'use strict';

/**
 * Preload bridge.
 *
 * Runs in an isolated world with `sandbox: true`, so it can talk to the main
 * process but has no filesystem or child-process powers of its own. Only the
 * explicit, narrow API below is exposed to the page as `window.api` — the
 * renderer can never reach `ipcRenderer` directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wrap `ipcRenderer.on` so the renderer receives only the payload, never the
 * Electron event object (which would leak `sender` into page scope).
 * @param {string} channel
 * @returns {(cb: (payload: any) => void) => () => void} unsubscribe function
 */
const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  /* environment ---------------------------------------------------------- */
  appInfo: () => ipcRenderer.invoke('app:info'),
  binariesStatus: () => ipcRenderer.invoke('binaries:status'),
  binariesVersions: () => ipcRenderer.invoke('binaries:versions'),

  /* settings ------------------------------------------------------------- */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),

  /* video ---------------------------------------------------------------- */
  analyze: (payload) => ipcRenderer.invoke('video:analyze', payload),
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', { id }),

  /* history -------------------------------------------------------------- */
  historyList: () => ipcRenderer.invoke('history:list'),
  historyRemove: (id) => ipcRenderer.invoke('history:remove', { id }),
  historyClear: () => ipcRenderer.invoke('history:clear'),

  /* shell ---------------------------------------------------------------- */
  openFolder: (dir) => ipcRenderer.invoke('shell:openFolder', { dir }),
  revealFile: (filePath) => ipcRenderer.invoke('shell:revealFile', { filePath }),
  openFile: (filePath) => ipcRenderer.invoke('shell:openFile', { filePath }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),

  /* live download events ------------------------------------------------- */
  onProgress: subscribe('download:progress'),
  onDone: subscribe('download:done'),
  onError: subscribe('download:error'),
  onCanceled: subscribe('download:canceled'),
  onLog: subscribe('download:log'),
});
