'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vr', {
  open: (url) => ipcRenderer.invoke('vr-open', url),
  setAlpha: (v) => ipcRenderer.invoke('vr-alpha-all', v),
  setOpt: (key, val) => ipcRenderer.invoke('vr-opt', key, val),
  closeAll: () => ipcRenderer.invoke('vr-close-all'),
  raise: () => ipcRenderer.invoke('vr-raise'),
  quit: () => ipcRenderer.invoke('vr-quit'),
  getState: () => ipcRenderer.invoke('vr-state'),
  fit: (h) => ipcRenderer.invoke('vr-fit', h),
  dropHistory: (u) => ipcRenderer.invoke('vr-history-drop', u),
  clearHistory: () => ipcRenderer.invoke('vr-history-clear'),
  minimize: () => ipcRenderer.invoke('vr-panel-min'),
  closePanel: () => ipcRenderer.invoke('vr-panel-hide'),
  onState: (cb) => ipcRenderer.on('vr-state', (_e, s) => cb(s)),
});
