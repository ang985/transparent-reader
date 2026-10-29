'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vrMini', {
  info: () => ipcRenderer.invoke('vr-mini-info'),
  expand: () => ipcRenderer.send('vr-mini-expand'),
});
