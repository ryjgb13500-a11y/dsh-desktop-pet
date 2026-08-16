// editor.js — DSH 桌宠网页化可视化编辑器（PPT/Flash 式）
// 素材库（点击/拖拽添加）→ 画布拖拽摆放 → 属性面板微调 → 保存到 pose_layout.json（宠物自动热重载）
'use strict'

const CANVAS_W = 560
const CANVAS_H = 600

const stage = document.getElementById('stage')
const g = stage.getContext('2d')
const wrap = document.getElementById('canvasWrap')
const statusEl = document.getElementById('status')

// ---------------- 素材分类 ----------------
const GROUPS = [
  { title: '身体与姿态', ids: ['sit_torso', 'stand_torso', 'sit_full', 'stand_full'] },
  { title: '头部（三种表情）', ids: ['head_sleep', 'head_surprised', 'head_serious'] },
  { title: '手臂（上臂/前臂/手）', ids: ['sit_left_upper_arm', 'sit_left_forearm', 'sit_left_hand', 'sit_right_upper_arm', 'sit_right_forearm', 'sit_right_hand'] },
  { title: '家具', ids: ['desk', 'chair_back', 'chair_front'] },
  { title: '道具', ids: ['quill', 'ink_bottle'] },
  { title: 'VFX 特效', ids: ['vfx_sleep_z', 'vfx_drool', 'vfx_snot_bubble', 'vfx_surprise', 'vfx_bubble_pop'] },
  { title: '图集组件（全部43个）', ids: Array.from({ length: 43 }, (_, i) => 'seg_' + String(i).padStart(2, '0')) },
]
const PART_IDS = ['sit_torso', 'stand_torso', 'sit_full', 'stand_full', 'head_sleep', 'head_surprised', 'head_serious',
  'sit_left_upper_arm', 'sit_left_forearm', 'sit_left_hand', 'sit_right_upper_arm', 'sit_right_forearm', 'sit_right_hand',
  'desk', 'chair_back', 'chair_front', 'quill', 'ink_bottle']
const VFX_IDS = ['vfx_sleep_z', 'vfx_drool', 'vfx_snot_bubble', 'vfx_surprise', 'vfx_bubble_pop']
const VFX_STORED = { vfx_sleep_z: 'zzz_origin', vfx_drool: 'drool', vfx_snot_bubble: 'snot_bubble', vfx_surprise: 'surprise', vfx_bubble_pop: 'bubble_pop' }
const VFX_ROWS = [
  { key: 'zzz_origin', rid: 'vfx_sleep_z', label: 'ZZZ 起点' },
  { key: 'snot_bubble', rid: 'vfx_snot_bubble', label: '鼻涕泡' },
  { key: 'drool', rid: 'vfx_drool', label: '口水' },
  { key: 'surprise', rid: 'vfx_surprise', label: '惊叹号' },
  { key: 'bubble_pop', rid: 'vfx_bubble_pop', label: '泡泡爆破' },
]

const HEAD_BY_POSE = { sleep: 'head_sleep', surprised: 'head_surprised', writing: 'head_serious' }

// ---------------- 全局数据 ----------------
let atlas = null          // HTMLImageElement
let rects = {}            // assetId -> {rect,...}
let layout = null         // pose_layout.json
let pose = 'sleep'
let zoom = 1
let showGrid = true

const sel = { kind: null, id: null }   // kind: part | vfx | joint
let dragging = false
let dragOX = 0, dragOY = 0
let dropTarget = null      // 拖放添加中的资产 id

// ---------------- 工具 ----------------
function partsOf() {
  const p = layout[pose]
  if (!p.parts) p.parts = {}
  return p.parts
}
function vfxOf() {
  const p = layout[pose]
  if (!p.vfx) p.vfx = {}
  return p.vfx
}
function drawOrderOf() {
  const p = layout[pose]
  if (!p.drawOrder || !Array.isArray(p.drawOrder)) {
    p.drawOrder = Object.keys(p.parts || {})
  }
  // 保证新增部件也在序列里
  for (const id of Object.keys(p.parts || {})) if (!p.drawOrder.includes(id)) p.drawOrder.push(id)
  return p.drawOrder
}
function hiddenOf() {
  const p = layout[pose]
  if (!p.hidden) p.hidden = []
  return p.hidden
}
function isHidden(id) {
  return hiddenOf().includes(id)
}
function hiddenVfxOf() {
  const p = layout[pose]
  if (!p.hiddenVfx) p.hiddenVfx = []
  return p.hiddenVfx
}
function isVfxHidden(key) {
  return hiddenVfxOf().includes(key)
}
function jointsOf() {
  const p = layout[pose]
  const out = []
  if (p.arm_chain_writing) {
    out.push({ id: 'w_shoulder', label: '写肩', pt: p.arm_chain_writing.shoulder })
    out.push({ id: 'w_elbow', label: '写肘', pt: p.arm_chain_writing.elbow })
    out.push({ id: 'w_wrist', label: '写腕', pt: p.arm_chain_writing.wrist })
    if (p.arm_chain_writing.quill_tip) out.push({ id: 'w_tip', label: '笔尖', pt: p.arm_chain_writing.quill_tip })
  }
  if (p.arm_chain_support) {
    out.push({ id: 's_shoulder', label: '撑肩', pt: p.arm_chain_support.shoulder })
    out.push({ id: 's_elbow', label: '撑肘', pt: p.arm_chain_support.elbow })
    out.push({ id: 's_wrist', label: '撑腕', pt: p.arm_chain_support.wrist })
  }
  return out
}
function getJoint(id) {
  const p = layout[pose]
  const wm = { w_shoulder: 'shoulder', w_elbow: 'elbow', w_wrist: 'wrist', w_tip: 'quill_tip' }
  const sm = { s_shoulder: 'shoulder', s_elbow: 'elbow', s_wrist: 'wrist' }
  if (id.startsWith('w_') && p.arm_chain_writing) return p.arm_chain_writing[wm[id]]
  if (id.startsWith('s_') && p.arm_chain_support) return p.arm_chain_support[sm[id]]
  return null
}

// ---------------- 加载 ----------------
async function load() {
  const data = await window.editorApi.readData()
  if (!data || data.error) throw new Error((data && data.error) || '读取失败')
  const img = new Image()
  img.src = 'data:image/png;base64,' + data.atlasB64
  await new Promise((ok, err) => { img.onload = ok; img.onerror = () => err(new Error('atlas 加载失败')) })
  atlas = img
  rects = JSON.parse(data.rectsText).assets || {}
  layout = JSON.parse(data.layoutText)
  buildLibrary()
  loadAnimPanel()
  render()
  // 撤销基线
  undoStack.length = 0
  redoStack.length = 0
  undoStack.push(JSON.stringify(layout))
  refreshUndoButtons()
}
load().catch((e) => {
  statusEl.textContent = '加载失败: ' + e.message
  statusEl.style.color = '#ff9d94'
})

// ---------------- 素材库 ----------------
function buildLibrary() {
  const host = document.getElementById('groups')
  host.innerHTML = ''
  for (const grp of GROUPS) {
    const t = document.createElement('div')
    t.className = 'grp-title'
    t.textContent = grp.title
    host.appendChild(t)
    const grid = document.createElement('div')
    grid.className = 'asset-grid'
    for (const id of grp.ids) {
      const e = rects[id]
      if (!e || !e.rect) continue
      const card = document.createElement('div')
      card.className = 'asset-card'
      card.dataset.id = id
      card.draggable = true
      const cv = document.createElement('canvas')
      cv.width = 64; cv.height = 64
      const cg = cv.getContext('2d')
      const [sx, sy, sw, sh] = e.rect
      const scale = Math.min(56 / sw, 56 / sh)
      cg.drawImage(atlas, sx, sy, sw, sh, 32 - sw * scale / 2, 32 - sh * scale / 2, sw * scale, sh * scale)
      const nm = document.createElement('span')
      nm.className = 'nm'
      nm.textContent = id
      card.appendChild(cv)
      card.appendChild(nm)
      // 点击添加
      card.addEventListener('click', () => addToPose(id))
      // 拖拽添加
      card.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', id)
        ev.dataTransfer.effectAllowed = 'copy'
      })
      grid.appendChild(card)
    }
    host.appendChild(grid)
  }
}

function addToPose(id) {
  if (VFX_IDS.includes(id)) {
    const key = VFX_STORED[id]
    if (!key) {
      flashStatus('ⓘ 泡泡爆破特效由惊醒动画自动触发，无需手动摆放')
      return
    }
    const v = vfxOf()
    if (!v[key]) {
      commitState()
      v[key] = { x: 280, y: 200, scale: 0.7 }
    }
    sel.kind = 'vfx'; sel.id = key
    render()
    renderProps()
    flashStatus(`✓ VFX 已就绪: ${key}${v[key] ? '' : ''}（画布中已显示，可直接拖动）`)
  } else {
    const p = partsOf()
    if (!p[id]) {
      commitState()
      p[id] = { x: 280, y: 300, scale: 0.7, rot: 0 }
      drawOrderOf().push(id)
      sel.kind = 'part'; sel.id = id
      render()
      renderProps()
      flashStatus(`✓ 已添加部件: ${id}`)
    } else {
      sel.kind = 'part'; sel.id = id
      render(); renderProps()
      flashStatus(`ⓘ ${id} 已存在，已选中`)
    }
  }
}

// ---------------- 渲染 ----------------
function render() {
  stage.width = CANVAS_W * zoom
  stage.height = CANVAS_H * zoom
  g.setTransform(zoom, 0, 0, zoom, 0, 0)
  g.clearRect(0, 0, CANVAS_W, CANVAS_H)
  if (!layout) return
  // 参考线
  if (showGrid) {
    g.save()
    g.strokeStyle = 'rgba(120,150,210,0.22)'
    g.lineWidth = 1
    g.strokeRect(0, 0, CANVAS_W, CANVAS_H)
    g.beginPath()
    g.moveTo(CANVAS_W / 2, 0); g.lineTo(CANVAS_W / 2, CANVAS_H)
    g.moveTo(0, CANVAS_H / 2); g.lineTo(CANVAS_W, CANVAS_H / 2)
    g.stroke()
    g.restore()
  }
  // 部件（drawOrder 顺序；隐藏的不画）
  const order = drawOrderOf()
  const parts = partsOf()
  for (const id of order) {
    if (isHidden(id)) continue
    const p = parts[id]
    const e = rects[id]
    if (!p || !e || !e.rect) continue
    drawSprite(e.rect, p.x, p.y, p.scale, p.rot)
  }
  // VFX
  const vfx = vfxOf()
  for (const row of VFX_ROWS) {
    const v = vfx[row.key]
    if (!v || isVfxHidden(row.key)) continue
    const e = rects[row.rid]
    if (row.key === 'zzz_origin') {
      g.save()
      g.fillStyle = 'rgba(143,184,232,0.95)'
      g.font = '700 18px "Segoe UI", sans-serif'
      g.textAlign = 'center'; g.textBaseline = 'middle'
      g.fillText('Z', v.x, v.y)
      g.restore()
      continue
    }
    if (!e || !e.rect) continue
    drawSprite(e.rect, v.x, v.y, v.scale, 0, 0.85)
  }
  // 关节
  for (const j of jointsOf()) {
    g.beginPath()
    g.arc(j.pt.x, j.pt.y, 6, 0, Math.PI * 2)
    g.fillStyle = sel.kind === 'joint' && sel.id === j.id ? '#ff4d6d' : 'rgba(255,190,60,0.9)'
    g.fill()
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1; g.stroke()
  }
  // 选中框
  if (sel.kind || sel.id) drawSelection()
  renderLayersMaybe()
}

function drawSprite(rect, x, y, scale, rot, alpha) {
  const [sx, sy, sw, sh] = rect
  g.save()
  g.translate(x, y)
  if (rot) g.rotate(rot)
  if (alpha !== undefined) g.globalAlpha = alpha
  g.drawImage(atlas, sx, sy, sw, sh, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale)
  g.restore()
}

function selData() {
  if (sel.kind === 'part') {
    const p = partsOf()[sel.id]
    const e = rects[sel.id]
    if (!p || !e || !e.rect) return null
    return { x: p.x, y: p.y, w: e.rect[2] * p.scale, h: e.rect[3] * p.scale, obj: p }
  }
  if (sel.kind === 'vfx') {
    const v = vfxOf()[sel.id]
    if (!v) return null
    const row = VFX_ROWS.find((r) => r.key === sel.id)
    const e = row ? rects[row.rid] : null
    const w = e && e.rect ? e.rect[2] * v.scale : 40
    const h = e && e.rect ? e.rect[3] * v.scale : 40
    return { x: v.x, y: v.y, w, h, obj: v }
  }
  if (sel.kind === 'joint') {
    const j = getJoint(sel.id)
    if (!j) return null
    return { x: j.x, y: j.y, w: 16, h: 16, obj: j }
  }
  return null
}

function drawSelection() {
  const d = selData()
  if (!d) return
  const w = Math.max(d.w, 16 / zoom)
  const h = Math.max(d.h, 16 / zoom)
  g.save()
  g.strokeStyle = '#ff4d6d'
  g.lineWidth = 2 / zoom
  g.setLineDash([6 / zoom, 4 / zoom])
  g.strokeRect(d.x - w / 2, d.y - h / 2, w, h)
  g.setLineDash([])
  g.beginPath()
  g.moveTo(d.x - 8, d.y); g.lineTo(d.x + 8, d.y)
  g.moveTo(d.x, d.y - 8); g.lineTo(d.x, d.y + 8)
  g.stroke()
  g.restore()
}

// ---------------- 命中测试（带最小命中区，极小部件也可点中） ----------------
const MIN_HIT = 14
function hitTest(mx, my) {
  for (const j of jointsOf()) {
    if (Math.abs(mx - j.pt.x) <= 10 && Math.abs(my - j.pt.y) <= 10) return { kind: 'joint', id: j.id }
  }
  const order = drawOrderOf().slice().reverse()
  const parts = partsOf()
  for (const id of order) {
    if (isHidden(id)) continue
    const p = parts[id]
    const e = rects[id]
    if (!p || !e || !e.rect) continue
    const hw = Math.max(e.rect[2] * p.scale / 2, MIN_HIT)
    const hh = Math.max(e.rect[3] * p.scale / 2, MIN_HIT)
    if (Math.abs(mx - p.x) <= hw && Math.abs(my - p.y) <= hh) {
      return { kind: 'part', id }
    }
  }
  // VFX 挂点（含泡泡爆破与 ZZZ 起点）
  const vfx = vfxOf()
  for (const row of VFX_ROWS) {
    const v = vfx[row.key]
    if (!v || isVfxHidden(row.key)) continue
    const e = rects[row.rid]
    const w = Math.max((e && e.rect ? e.rect[2] * v.scale : 40) / 2, MIN_HIT)
    const h = Math.max((e && e.rect ? e.rect[3] * v.scale : 40) / 2, MIN_HIT)
    if (Math.abs(mx - v.x) <= w && Math.abs(my - v.y) <= h) return { kind: 'vfx', id: row.key }
  }
  return { kind: null, id: null }
}

// ---------------- 画布交互 ----------------
stage.addEventListener('mousedown', (e) => {
  const rect = stage.getBoundingClientRect()
  const mx = (e.clientX - rect.left) / zoom
  const my = (e.clientY - rect.top) / zoom
  const hit = hitTest(mx, my)
  sel.kind = hit.kind
  sel.id = hit.id
  if (hit.kind) {
    commitState()   // 拖动/关节移动前存档
    dragging = true
    const d = selData()
    dragOX = mx - d.x
    dragOY = my - d.y
  }
  render()
  renderProps()
})
window.addEventListener('mousemove', (e) => {
  if (!dragging || (!sel.kind && !sel.id)) return
  const rect = stage.getBoundingClientRect()
  const mx = (e.clientX - rect.left) / zoom
  const my = (e.clientY - rect.top) / zoom
  const nx = Math.min(Math.max(Math.round(mx - dragOX), 0), CANVAS_W)
  const ny = Math.min(Math.max(Math.round(my - dragOY), 0), CANVAS_H)
  const d = selData()
  if (d) {
    d.obj.x = nx
    d.obj.y = ny
  }
  render()
  renderProps()
})
window.addEventListener('mouseup', () => { dragging = false })

stage.addEventListener('wheel', (e) => {
  e.preventDefault()
  const d = selData()
  if (!d) return
  commitState()
  const step = e.deltaY < 0 ? 0.03 : -0.03
  d.obj.scale = Math.max(0.1, Math.round((d.obj.scale + step) * 100) / 100)
  render()
  renderProps()
}, { passive: false })

// 拖放入画布
stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' })
stage.addEventListener('drop', (e) => {
  e.preventDefault()
  const id = e.dataTransfer.getData('text/plain')
  if (!id) return
  addToPose(id)
})

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault()
    redo()
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    cycleSelection()
    render(); renderProps()
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.kind === 'part') {
    commitState()
    delete partsOf()[sel.id]
    const order = drawOrderOf()
    const i = order.indexOf(sel.id)
    if (i >= 0) order.splice(i, 1)
    sel.kind = null; sel.id = null
    render(); renderProps()
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.kind === 'vfx') {
    commitState()
    delete vfxOf()[sel.id]
    sel.kind = null; sel.id = null
    render(); renderProps()
  }
})

// ---------------- 图层面板（PS 式） ----------------
let layersKey = ''
function renderLayersMaybe() {
  const vfxKeys = VFX_ROWS.map((r) => r.key + (vfxOf()[r.key] ? '1' : '0')).join(',')
  const key = pose + '|' + drawOrderOf().join(',') + '|' + hiddenOf().join(',') + '|' + hiddenVfxOf().join(',') + '|' + vfxKeys + '|' + (sel.kind === 'part' ? sel.id : '') + '|' + (sel.kind === 'vfx' ? sel.id : '')
  if (key === layersKey) return
  layersKey = key
  renderLayers()
}
function renderLayers() {
  const host = document.getElementById('layers')
  if (!host) return
  host.innerHTML = ''
  const order = drawOrderOf()
  const parts = partsOf()
  // 顶层在上（PS 风格）
  const topFirst = order.slice().reverse()
  let count = 0
  for (const id of topFirst) {
    const p = parts[id]
    const e = rects[id]
    if (!p || !e || !e.rect) continue
    count++
    const hidden = isHidden(id)
    const row = document.createElement('div')
    row.className = 'layer-row' + (sel.kind === 'part' && sel.id === id ? ' selected' : '') + (hidden ? ' hidden-row' : '')
    row.draggable = true
    // 缩略图
    const thumb = document.createElement('canvas')
    thumb.className = 'thumb'
    thumb.width = 40; thumb.height = 40
    const cg = thumb.getContext('2d')
    const [sx, sy, sw, sh] = e.rect
    const s = Math.min(36 / sw, 36 / sh)
    cg.drawImage(atlas, sx, sy, sw, sh, 20 - sw * s / 2, 20 - sh * s / 2, sw * s, sh * s)
    // 名称
    const nm = document.createElement('span')
    nm.className = 'lname'
    nm.textContent = id
    // 眼睛（显隐）
    const eye = document.createElement('button')
    eye.className = 'eye'
    eye.textContent = hidden ? '🚫' : '👁'
    eye.title = hidden ? '点击显示' : '点击隐藏'
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation()
      commitState()
      const h = hiddenOf()
      const i = h.indexOf(id)
      if (i >= 0) h.splice(i, 1)
      else {
        h.push(id)
        if (sel.kind === 'part' && sel.id === id) { sel.kind = null; sel.id = null }
      }
      render(); renderProps()
      flashStatus(hidden ? `✓ 已显示 ${id}` : `✓ 已隐藏 ${id}`)
    })
    row.appendChild(thumb)
    row.appendChild(nm)
    row.appendChild(eye)
    // 点击选中
    row.addEventListener('click', () => {
      sel.kind = 'part'; sel.id = id
      render(); renderProps()
    })
    // 拖拽排序
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', id)
      ev.dataTransfer.effectAllowed = 'move'
    })
    row.addEventListener('dragover', (ev) => ev.preventDefault())
    row.addEventListener('drop', (ev) => {
      ev.preventDefault()
      const src = ev.dataTransfer.getData('text/plain')
      if (!src || src === id) return
      const o = drawOrderOf()
      const si = o.indexOf(src)
      const di = o.indexOf(id)
      if (si < 0 || di < 0) return
      commitState()
      o.splice(si, 1)
      o.splice(di, 0, src)
      render(); renderProps()
      flashStatus(`✓ 图层顺序已调整：${src} → ${id} 的位置`)
    })
    host.appendChild(row)
  }
  // ---- 特效层（VFX 挂点） ----
  const vfx = vfxOf()
  let vfxCount = 0
  for (const vrow of VFX_ROWS) {
    const v = vfx[vrow.key]
    if (!v) continue
    vfxCount++
    const vhidden = isVfxHidden(vrow.key)
    const row = document.createElement('div')
    row.className = 'layer-row vfx-row' + (sel.kind === 'vfx' && sel.id === vrow.key ? ' selected' : '') + (vhidden ? ' hidden-row' : '')
    const thumb = document.createElement('canvas')
    thumb.className = 'thumb'
    thumb.width = 40; thumb.height = 40
    const cg = thumb.getContext('2d')
    if (vrow.key === 'zzz_origin') {
      cg.font = '700 18px "Segoe UI", sans-serif'
      cg.textAlign = 'center'; cg.textBaseline = 'middle'
      cg.fillStyle = '#8fb8e8'
      cg.fillText('Z', 20, 20)
    } else {
      const e = rects[vrow.rid]
      if (e && e.rect) {
        const [sx, sy, sw, sh] = e.rect
        const s = Math.min(36 / sw, 36 / sh)
        cg.drawImage(atlas, sx, sy, sw, sh, 20 - sw * s / 2, 20 - sh * s / 2, sw * s, sh * s)
      }
    }
    const nm = document.createElement('span')
    nm.className = 'lname'
    nm.textContent = '✨ ' + vrow.label
    const eye = document.createElement('button')
    eye.className = 'eye'
    eye.textContent = vhidden ? '🚫' : '👁'
    eye.title = vhidden ? '点击显示' : '点击隐藏'
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation()
      commitState()
      const h = hiddenVfxOf()
      const i = h.indexOf(vrow.key)
      if (i >= 0) h.splice(i, 1)
      else {
        h.push(vrow.key)
        if (sel.kind === 'vfx' && sel.id === vrow.key) { sel.kind = null; sel.id = null }
      }
      render(); renderProps()
      flashStatus(vhidden ? `✓ 已显示 ${vrow.label}` : `✓ 已隐藏 ${vrow.label}`)
    })
    row.appendChild(thumb)
    row.appendChild(nm)
    row.appendChild(eye)
    row.addEventListener('click', () => {
      sel.kind = 'vfx'; sel.id = vrow.key
      render(); renderProps()
    })
    host.appendChild(row)
  }
  if (!count && !vfxCount) {
    host.innerHTML = '<p class="dim">当前姿态没有部件<br>从左侧素材库点击添加</p>'
  }
}

// ---------------- 属性面板 ----------------
function renderProps() {
  const body = document.getElementById('propBody')
  const d = selData()
  if (!d || !sel.kind) {
    body.innerHTML = '<p class="dim">先在画布中点选一个部件</p>'
    return
  }
  const obj = d.obj
  const name = sel.kind === 'joint' ? sel.id : sel.id
  const rows = [
    ['x', 'x'], ['y', 'y'],
  ]
  if (obj.scale !== undefined) rows.push(['scale', '缩放'])
  if (obj.rot !== undefined) rows.push(['rot', '旋转(rad)'])
  body.innerHTML = ''
  const title = document.createElement('p')
  title.style.cssText = 'margin-bottom:10px;font-weight:700;color:#cfe0f7;word-break:break-all'
  title.textContent = (sel.kind === 'part' ? '部件: ' : sel.kind === 'vfx' ? 'VFX: ' : '关节: ') + name
  body.appendChild(title)
  for (const [key, label] of rows) {
    const row = document.createElement('div')
    row.className = 'prop-row'
    row.innerHTML = `<label>${label}</label><input type="number" step="1" value="${Math.round(obj[key] * 100) / 100}"><span class="spin"><button data-d="-1">−</button><button data-d="1">+</button></span>`
    const input = row.querySelector('input')
    const step = key === 'rot' ? 0.05 : key === 'scale' ? 0.02 : 1
    input.addEventListener('change', () => {
      const v = parseFloat(input.value)
      if (!isNaN(v)) { commitState(); obj[key] = v; render() }
    })
    row.querySelectorAll('.spin button').forEach((b) => {
      b.addEventListener('click', () => {
        commitState()
        obj[key] = Math.round((obj[key] + step * parseFloat(b.dataset.d)) * 100) / 100
        input.value = Math.round(obj[key] * 100) / 100
        render()
      })
    })
    body.appendChild(row)
  }
  const btns = document.createElement('div')
  btns.className = 'prop-btns'
  if (sel.kind === 'part') {
    const order = drawOrderOf()
    const layerIdx = order.indexOf(sel.id)
    const layerInfo = document.createElement('p')
    layerInfo.style.cssText = 'width:100%;margin-bottom:6px;color:#93a5c4;font-size:12px'
    layerInfo.textContent = `图层：第 ${layerIdx + 1} / ${order.length} 层（数值越大越靠上）`
    body.appendChild(layerInfo)
    const up = document.createElement('button'); up.textContent = '⬆ 上移一层'
    up.addEventListener('click', () => {
      const o = drawOrderOf()
      const i = o.indexOf(sel.id)
      if (i >= 0 && i < o.length - 1) {
        commitState()
        o.splice(i, 1); o.splice(i + 1, 0, sel.id)
        render(); renderProps()
        flashStatus(`✓ ${sel.id} 已上移（第 ${i + 2}/${o.length} 层）`)
      } else {
        flashStatus(`ⓘ ${sel.id} 已在最顶层，无法上移`)
      }
    })
    const dn = document.createElement('button'); dn.textContent = '⬇ 下移一层'
    dn.addEventListener('click', () => {
      const o = drawOrderOf()
      const i = o.indexOf(sel.id)
      if (i > 0) {
        commitState()
        o.splice(i, 1); o.splice(i - 1, 0, sel.id)
        render(); renderProps()
        flashStatus(`✓ ${sel.id} 已下移（第 ${i}/${o.length} 层）`)
      } else {
        flashStatus(`ⓘ ${sel.id} 已在最底层，无法下移`)
      }
    })
    btns.appendChild(up); btns.appendChild(dn)
  }
  const del = document.createElement('button')
  del.className = 'danger'
  del.textContent = '删除'
  del.addEventListener('click', () => {
    commitState()
    if (sel.kind === 'part') {
      delete partsOf()[sel.id]
      const order = drawOrderOf()
      const i = order.indexOf(sel.id)
      if (i >= 0) order.splice(i, 1)
    } else if (sel.kind === 'vfx') {
      delete vfxOf()[sel.id]
    }
    sel.kind = null; sel.id = null
    render(); renderProps()
  })
  btns.appendChild(del)
  body.appendChild(btns)
}

// ---------------- 撤销 / 重做 ----------------
const undoStack = []
const redoStack = []
let lastCommitAt = 0
function commitState() {
  const now = Date.now()
  if (now - lastCommitAt < 400) return  // 连续操作（如滚轮）合并为一步
  lastCommitAt = now
  const snap = JSON.stringify(layout)
  if (undoStack.length && undoStack[undoStack.length - 1] === snap) return  // 无变化
  undoStack.push(snap)
  if (undoStack.length > 50) undoStack.shift()
  redoStack.length = 0
  refreshUndoButtons()
}
function undo() {
  if (!undoStack.length) return
  redoStack.push(JSON.stringify(layout))
  layout = JSON.parse(undoStack.pop())
  sel.kind = null; sel.id = null
  render(); renderProps()
  refreshUndoButtons()
  flashStatus('↩ 已撤销上一步')
}
function redo() {
  if (!redoStack.length) return
  undoStack.push(JSON.stringify(layout))
  layout = JSON.parse(redoStack.pop())
  sel.kind = null; sel.id = null
  render(); renderProps()
  refreshUndoButtons()
  flashStatus('↪ 已重做')
}
function refreshUndoButtons() {
  const bu = document.getElementById('btnUndo')
  const br = document.getElementById('btnRedo')
  if (bu) { bu.disabled = !undoStack.length; bu.style.opacity = undoStack.length ? '1' : '0.45' }
  if (br) { br.disabled = !redoStack.length; br.style.opacity = redoStack.length ? '1' : '0.45' }
}
document.getElementById('btnUndo').addEventListener('click', undo)
document.getElementById('btnRedo').addEventListener('click', redo)

// ---------------- 辅助 ----------------
let flashTimer = null
function flashStatus(msg) {
  statusEl.textContent = msg
  statusEl.style.color = '#ffd23e'
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { statusEl.textContent = '' }, 2500)
}
function cycleSelection() {
  const ids = Object.keys(partsOf())
  if (!ids.length) return
  const curIdx = sel.kind === 'part' ? ids.indexOf(sel.id) : -1
  const next = ids[(curIdx + 1) % ids.length]
  sel.kind = 'part'
  sel.id = next
}

// ---------------- 姿态与工具条 ----------------
document.getElementById('poseTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  pose = btn.dataset.pose
  document.querySelectorAll('#poseTabs button').forEach((b) => b.classList.toggle('active', b === btn))
  sel.kind = null; sel.id = null
  render(); renderProps()
})
document.getElementById('poseTabs').querySelector('[data-pose="sleep"]').classList.add('active')

let zoomIdx = 2
const ZOOMS = [0.5, 0.75, 1, 1.5, 2]
function applyZoom(z) {
  zoom = z
  document.getElementById('zoomLabel').textContent = Math.round(z * 100) + '%'
  render()
}
document.getElementById('zoomIn').addEventListener('click', () => { zoomIdx = Math.min(zoomIdx + 1, ZOOMS.length - 1); applyZoom(ZOOMS[zoomIdx]) })
document.getElementById('zoomOut').addEventListener('click', () => { zoomIdx = Math.max(zoomIdx - 1, 0); applyZoom(ZOOMS[zoomIdx]) })
document.getElementById('zoomFit').addEventListener('click', () => {
  const w = wrap.clientWidth - 24
  const h = wrap.clientHeight - 24
  applyZoom(Math.max(0.3, Math.min(w / CANVAS_W, h / CANVAS_H)))
})
document.getElementById('chkGrid').addEventListener('change', (e) => { showGrid = e.target.checked; render() })

// ---------------- 保存 ----------------
document.getElementById('btnSave').addEventListener('click', async () => {
  statusEl.textContent = '保存中…'
  statusEl.style.color = '#ffd23e'
  try {
    const r = await window.editorApi.saveLayout(JSON.stringify(layout))
    if (r === true) {
      statusEl.textContent = '✓ 已保存，宠物已自动应用新布局'
      statusEl.style.color = '#7fd4a8'
      setTimeout(() => { statusEl.textContent = '' }, 4000)
    } else {
      statusEl.textContent = '保存失败: ' + (r || '')
      statusEl.style.color = '#ff9d94'
    }
  } catch (e) {
    statusEl.textContent = '保存失败: ' + e.message
    statusEl.style.color = '#ff9d94'
  }
})

// ---------------- 动作绑定面板 ----------------
const ANIM_TARGET_OPTIONS = ['stand_torso', 'head_sleep', 'head_surprised', 'head_serious', 'desk', 'chair_front', 'chair_back', 'sit_left_hand', 'sit_right_hand', 'quill', 'ink_bottle']

function buildAnimChecks(boxId, targets) {
  const box = document.getElementById(boxId)
  box.innerHTML = ''
  ANIM_TARGET_OPTIONS.forEach(id => {
    const label = document.createElement('label')
    label.className = 'chk'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.dataset.id = id
    cb.checked = targets.includes(id)
    label.appendChild(cb)
    label.appendChild(document.createTextNode(' ' + id.replace(/^(sit_|stand_)/, '')))
    box.appendChild(label)
  })
  box.addEventListener('change', () => {
    // 勾选状态不立即存，保存时统一读
  })
}

function loadAnimPanel() {
  const anim = layout.animation || {}
  const breath = anim.breath || {}
  const wake = anim.wake || {}
  const writing = anim.writing || {}
  buildAnimChecks('animBreathTargets', breath.targets || ['stand_torso'])
  document.getElementById('animBreathAmp').value = breath.amplitude !== undefined ? breath.amplitude : 1.6
  document.getElementById('animBreathCycle').value = breath.cycle_ms || 3200
  document.getElementById('animWakePop').value = wake.pop_ms !== undefined ? wake.pop_ms : 350
  document.getElementById('animWakeSurprise').value = wake.surprise_ms !== undefined ? wake.surprise_ms : 600
  document.getElementById('animWakeFade').value = wake.fade_ms !== undefined ? wake.fade_ms : 400
  buildAnimChecks('animWriteTargets', writing.targets || ['sit_right_hand', 'quill'])
  document.getElementById('animWriteAmp').value = writing.amplitude !== undefined ? writing.amplitude : 5
  document.getElementById('animWriteSpeed').value = writing.speed_ms || 220
}

function collectChecks(boxId) {
  const out = []
  document.querySelectorAll('#' + boxId + ' input[type=checkbox]').forEach(cb => {
    if (cb.checked) out.push(cb.dataset.id)
  })
  return out
}

document.getElementById('btnSaveAnim').addEventListener('click', async () => {
  if (!layout.animation) layout.animation = {}
  layout.animation.breath = {
    targets: collectChecks('animBreathTargets'),
    amplitude: parseFloat(document.getElementById('animBreathAmp').value) || 1.6,
    cycle_ms: parseInt(document.getElementById('animBreathCycle').value) || 3200,
  }
  layout.animation.wake = {
    pop_ms: parseInt(document.getElementById('animWakePop').value) || 350,
    surprise_ms: parseInt(document.getElementById('animWakeSurprise').value) || 600,
    fade_ms: parseInt(document.getElementById('animWakeFade').value) || 400,
  }
  layout.animation.writing = {
    targets: collectChecks('animWriteTargets'),
    amplitude: parseFloat(document.getElementById('animWriteAmp').value) || 5,
    speed_ms: parseInt(document.getElementById('animWriteSpeed').value) || 220,
  }
  statusEl.textContent = '动作绑定保存中…'
  try {
    const r = await window.editorApi.saveLayout(JSON.stringify(layout))
    if (r === true) {
      statusEl.textContent = '✓ 动作绑定已保存，宠物已应用'
      statusEl.style.color = '#7fd4a8'
      setTimeout(() => { statusEl.textContent = '' }, 4000)
    } else {
      statusEl.textContent = '保存失败: ' + (r || '')
      statusEl.style.color = '#ff9d94'
    }
  } catch (e) {
    statusEl.textContent = '保存失败: ' + e.message
    statusEl.style.color = '#ff9d94'
  }
})

applyZoom(1)
