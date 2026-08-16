// preload.js — contextBridge：把 IPC 面暴露给渲染进程
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshPet', {
  readAsset: (name) => ipcRenderer.invoke('read-asset', name),
  saveRects: (text) => ipcRenderer.invoke('save-rects', text),
  saveLayout: (text) => ipcRenderer.invoke('save-layout', text),
  dragStart: (offset) => ipcRenderer.send('drag-start', offset),
  dragEnd: () => ipcRenderer.send('drag-end'),
  openMenu: () => ipcRenderer.send('pet-menu'),
  onCommand: (fn) => ipcRenderer.on('pet-cmd', (_e, payload) => fn(payload)),
  onTask: (fn) => ipcRenderer.on('pet-task', (_e, payload) => fn(payload)),
})
