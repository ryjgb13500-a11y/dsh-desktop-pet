// main.js — DSH Desktop Pet · Electron 主进程
// 透明无边框窗口、拖动、右键菜单、位置持久化、DSH 任务桥（/pet/status 轮询）
const { app, BrowserWindow, ipcMain, Menu, screen, Tray, nativeImage, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const DSH_URL = process.env.DSH_PET_STATUS_URL || 'http://127.0.0.1:3080/pet/status'
const POLL_MS = 250
const MAX_FAILS = 6              // 连续失败次数 → 判定 DSH 已关闭
const WATCH_MODE = process.argv.includes('--watch')   // DSH 拉起时传 --watch：DSH 死后宠物退出
const DEMO_MODE = process.argv.includes('--demo')

const ROOT = __dirname
const RENDERER = path.join(ROOT, 'renderer', 'index.html')
if (process.env.DSH_PET_USERDATA) app.setPath('userData', process.env.DSH_PET_USERDATA)
const POS_FILE = path.join(app.getPath('userData'), 'pet-position.json')
const RECTS_FILE = path.join(ROOT, 'assets', 'atlas_rects.json')

let win = null
let tray = null
let editorWin = null
let dragTimer = null
let dragOffset = null
let pollTimer = null
let failCount = 0
let paused = false

// 简易文件日志（宠物侧诊断）
function petLog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'pet.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch { }
}

function clampToVisible(x, y, w, h) {
  const displays = screen.getAllDisplays()
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x); minY = Math.min(minY, d.bounds.y)
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width); maxY = Math.max(maxY, d.bounds.y + d.bounds.height)
  }
  const nx = Math.min(Math.max(x, minX - w + 80), maxX - 80)
  const ny = Math.min(Math.max(y, minY - h + 80), maxY - 80)
  return [nx, ny]
}

function loadPosition() {
  try {
    const p = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'))
    // 恢复缩放
    if (typeof p.scale === 'number' && p.scale > 0.2 && p.scale < 5) {
      petScale = p.scale
    }
    if (typeof p.x === 'number' && typeof p.y === 'number') return clampToVisible(p.x, p.y, 560, 600)
  } catch { /* 首次运行 */ }
  const wa = screen.getPrimaryDisplay().workArea
  return [wa.x + wa.width - 620, wa.y + wa.height - 640]
}

function savePosition() {
  if (!win) return
  const [x, y] = win.getPosition()
  try {
    fs.mkdirSync(path.dirname(POS_FILE), { recursive: true })
    const pos = JSON.parse(fs.existsSync(POS_FILE) ? fs.readFileSync(POS_FILE, 'utf-8') : '{}')
    pos.x = x; pos.y = y
    if (petScale !== undefined) pos.scale = petScale
    fs.writeFileSync(POS_FILE, JSON.stringify(pos))
  } catch { }
}

// ---------- 桌宠窗口等比缩放 ----------
let petScale = 1
const PET_BASE = { w: 560, h: 600 }
const SCALE_OPTIONS = [0.6, 0.8, 1, 1.25, 1.5, 2]
function setPetScale(ratio) {
  if (!win || win.isDestroyed()) return
  petScale = ratio
  win.setContentSize(Math.round(PET_BASE.w * ratio), Math.round(PET_BASE.h * ratio))
  // zoomFactor 等比缩放整个页面：canvas 内素材相对位置完全不变
  win.webContents.setZoomFactor(ratio)
  savePosition()
  petLog(`pet scale set to ${Math.round(ratio * 100)}%`)
}
function buildScaleMenu() {
  return SCALE_OPTIONS.map(r => ({
    label: `${Math.round(r * 100)}%`,
    type: 'radio',
    checked: Math.abs(petScale - r) < 0.01,
    click: () => setPetScale(r),
  }))
}

function createWindow() {
  const [x, y] = loadPosition()
  win = new BrowserWindow({
    x, y,
    width: Math.round(PET_BASE.w * petScale),
    height: Math.round(PET_BASE.h * petScale),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.setZoomFactor(petScale)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(RENDERER)
  win.on('closed', () => { win = null })
  win.on('move', () => { if (!dragTimer) savePosition() })
}

// ---------- 拖动（屏幕坐标轮询） ----------
ipcMain.on('drag-start', (_e, offset) => {
  if (!win || paused) return
  dragOffset = offset
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint()
    win.setPosition(Math.round(p.x - dragOffset.x), Math.round(p.y - dragOffset.y))
  }, 16)
})
ipcMain.on('drag-end', () => {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  dragOffset = null
  savePosition()
})

// ---------- 右键菜单 ----------
ipcMain.on('pet-menu', () => {
  const template = [
    paused
      ? { label: '恢复宠物', click: () => { paused = false; win.webContents.send('pet-cmd', { cmd: 'resume' }) } }
      : { label: '暂停宠物', click: () => { paused = true; win.webContents.send('pet-cmd', { cmd: 'pause' }) } },
    { label: '隐藏宠物', click: () => win.hide() },
    { label: '调整大小', submenu: buildScaleMenu() },
    { label: '重新定位', click: () => { const [x, y] = clampToVisible(screen.getPrimaryDisplay().workArea.x + 80, screen.getPrimaryDisplay().workArea.y + 80, 560, 600); win.setPosition(x, y); savePosition() } },
    { type: 'separator' },
    { label: '打开可视化编辑器 (C)', click: () => win.webContents.send('pet-cmd', { cmd: 'calibrate' }) },
    { label: '打开网页编辑器（大窗口）', click: () => openEditor() },
    { label: '▶ 动作演示（测试循环）', click: () => win.webContents.send('pet-cmd', { cmd: 'demo-toggle' }) },
    { label: '调试图集页', click: () => shell.openPath(path.join(ROOT, 'tools', 'debug_atlas.html')) },
    { type: 'separator' },
    { label: '退出宠物', click: () => app.quit() },
  ]
  Menu.buildFromTemplate(template).popup({ window: win })
})

// ---------- 网页化可视化编辑器（宠物应用的第二个大窗口） ----------
function openEditor() {
  try {
    if (editorWin && !editorWin.isDestroyed()) { editorWin.focus(); return }
    petLog('opening editor window')
    editorWin = new BrowserWindow({
      width: 1360,
      height: 860,
      title: 'DSH 桌宠 · 可视化编辑器',
      autoHideMenuBar: true,
      backgroundColor: '#151a24',
      webPreferences: {
        preload: path.join(ROOT, 'editor-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    editorWin.loadFile(path.join(ROOT, 'editor', 'index.html'))
    editorWin.on('closed', () => { editorWin = null })
    petLog('editor window created')
  } catch (e) {
    petLog('editor open failed: ' + String((e && e.stack) || e))
  }
}
ipcMain.handle('editor-data', () => {
  try {
    return {
      atlasB64: fs.readFileSync(path.join(ROOT, 'assets', 'character_sprite_atlas.png')).toString('base64'),
      rectsText: fs.readFileSync(RECTS_FILE, 'utf8'),
      layoutText: fs.readFileSync(path.join(ROOT, 'assets', 'pose_layout.json'), 'utf8'),
    }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
})
ipcMain.handle('editor-save-layout', (_e, text) => {
  try {
    fs.writeFileSync(path.join(ROOT, 'assets', 'pose_layout.json'), text)
    // 通知宠物窗口热重载
    if (win && !win.isDestroyed()) win.webContents.send('pet-cmd', { cmd: 'reload-layout' })
    petLog('layout saved via editor — pet hot reload')
    return true
  } catch (e) { return String((e && e.message) || e) }
})
ipcMain.handle('editor-save-rects', (_e, text) => {
  try {
    fs.writeFileSync(RECTS_FILE, text)
    if (win && !win.isDestroyed()) win.webContents.send('pet-cmd', { cmd: 'reload-layout' })
    return true
  } catch (e) { return String((e && e.message) || e) }
})

// ---------- 托盘（隐藏后从这里恢复显示） ----------
function setupTray() {
  try {
    const iconPath = path.join(ROOT, 'assets', 'tray-icon.png')
    let img
    if (fs.existsSync(iconPath)) img = nativeImage.createFromPath(iconPath)
    else img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR4nGNgGAWjYBSMglEwCkbBKBhK4P///4z//v1j+Pv3L8O/f/8YAFpLBv9hH0lyAAAAAElFTkSuQmCC')
    tray = new Tray(img)
    tray.setToolTip('DSH 桌宠')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示宠物', click: () => { win.show() } },
      { label: '暂停/恢复', click: () => { paused = !paused; win.webContents.send('pet-cmd', { cmd: paused ? 'pause' : 'resume' }) } },
      { type: 'separator' },
      { label: '退出宠物', click: () => app.quit() },
    ]))
    tray.on('click', () => { win.show() })
  } catch (e) {
    console.warn('tray unavailable:', e.message)
  }
}

// ---------- 任务桥：轮询 DSH /pet/status ----------
let lastLayoutRev = null
let lastRunning = null
async function pollStatus() {
  if (DEMO_MODE) return
  try {
    const res = await fetch(DSH_URL, { signal: AbortSignal.timeout(1500) })
    const data = await res.json()
    if (failCount > 0) petLog(`status restored after ${failCount} failures`)
    failCount = 0
    if (win && !win.isDestroyed()) {
      // 只在 running 状态变化时才发事件（防止每轮轮询重置动画状态机）
      const running = !!data.running
      if (lastRunning !== running) {
        lastRunning = running
        win.webContents.send('pet-task', { running })
      }
      // 布局文件被编辑器保存 → 热重载（无需重启进程）
      if (data.layoutRev && lastLayoutRev !== null && data.layoutRev !== lastLayoutRev) {
        petLog(`layout changed (${lastLayoutRev} → ${data.layoutRev}) — hot reload`)
        win.webContents.send('pet-cmd', { cmd: 'reload-layout' })
      }
      if (data.layoutRev !== undefined) lastLayoutRev = data.layoutRev
    }
  } catch {
    failCount++
    petLog(`poll fail #${failCount} (${DSH_URL})`)
    if (WATCH_MODE && failCount >= MAX_FAILS) {
      petLog(`DSH unreachable for ${failCount} polls — exiting (watch mode)`)
      app.quit()
    }
  }
}

// ---------- 资产读取（供渲染进程） ----------
ipcMain.handle('read-asset', (_e, name) => {
  const map = {
    'atlas.png': path.join(ROOT, 'assets', 'character_sprite_atlas.png'),
    'atlas_rects.json': RECTS_FILE,
    'pose_layout.json': path.join(ROOT, 'assets', 'pose_layout.json'),
    'manifest.json': path.join(ROOT, 'assets', 'dsh_manifest.json'),
  }
  const file = map[name]
  if (!file) return null
  try {
    const buf = fs.readFileSync(file)
    if (name.endsWith('.png')) return buf.toString('base64')
    return buf.toString('utf8')
  } catch {
    return null
  }
})
ipcMain.handle('save-rects', (_e, text) => {
  try { fs.writeFileSync(RECTS_FILE, text); return true } catch (e) { return String(e.message) }
})
ipcMain.handle('save-layout', (_e, text) => {
  try {
    fs.writeFileSync(path.join(ROOT, 'assets', 'pose_layout.json'), text)
    return true
  } catch (e) { return String(e.message) }
})

app.whenReady().then(() => {
  petLog(`pet starting (watch=${WATCH_MODE}, demo=${DEMO_MODE}, status=${DSH_URL})`)
  createWindow()
  setupTray()
  pollTimer = setInterval(pollStatus, POLL_MS)
  pollStatus()
  if (process.argv.includes('--editor')) openEditor()   // 启动时顺带打开编辑器
  app.on('activate', () => { if (win === null) createWindow() })
})

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer)
  if (dragTimer) clearInterval(dragTimer)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
