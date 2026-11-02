'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vrMini', {
  info: () => ipcRenderer.invoke('vr-mini-info'),
  expand: () => ipcRenderer.send('vr-mini-expand'),
  // 胶囊有焦点时按 Alt+P，把控制面板叫出来（主进程侧接的就是 vr-panel → showPanel）
  panel: () => ipcRenderer.send('vr-panel'),
});
