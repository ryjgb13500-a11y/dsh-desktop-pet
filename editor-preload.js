// editor-preload.js — 编辑器窗口的 IPC 面
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('editorApi', {
  readData: () => ipcRenderer.invoke('editor-data'),
  saveLayout: (text) => ipcRenderer.invoke('editor-save-layout', text),
  saveRects: (text) => ipcRenderer.invoke('editor-save-rects', text),
})
