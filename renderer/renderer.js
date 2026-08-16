// renderer.js — DSH Desktop Pet 渲染进程
// 装配布局由 assets/pose_layout.json 驱动，部件 rect 由 atlas_rects.json 驱动
'use strict'

/* global dshPet */
const canvas = document.getElementById('scene')
const g = canvas.getContext('2d')
const hud = document.getElementById('hud')
const DPR = Math.min(window.devicePixelRatio || 1, 2)
canvas.width = 560 * DPR
canvas.height = 600 * DPR
canvas.style.width = '560px'
canvas.style.height = '600px'
g.scale(DPR, DPR)
const W = 560, H = 600

// ---------------- 状态机 ----------------
const State = {
  INITIALIZING: 'INITIALIZING',
  IDLE_SLEEP: 'IDLE_SLEEP',
  WAKE_UP: 'WAKE_UP',
  WRITING: 'WRITING',
  RETURN_TO_SLEEP: 'RETURN_TO_SLEEP',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
}
const PRIORITY = { ERROR: 50, WAKE_UP: 40, WRITING: 30, RETURN_TO_SLEEP: 20, IDLE_SLEEP: 10 }
const sm = {
  state: State.INITIALIZING,
  since: 0,
  taskRunning: false,
  paused: false,
  transition(next, now, force = false) {
    if (this.paused && next !== State.PAUSED) return false
    if (!force && PRIORITY[next] < PRIORITY[this.state]) return false
    if (next === this.state) return false
    this.state = next
    this.since = now
    onStateEnter(next, now)
    return true
  },
  onTask(running, now) {
    this.taskRunning = running
    if (this.paused) return
    if (running) {
      // 重入保护：已在唤醒/写字态时不重复触发（防轮询抖动重置状态）
      if (this.state !== State.WAKE_UP && this.state !== State.WRITING) {
        this.transition(State.WAKE_UP, now)
      }
    } else if (this.state === State.WRITING) {
      this.transition(State.RETURN_TO_SLEEP, now, true)
    }
  },
}

// ---------------- 资源 ----------------
let atlas = null          // HTMLImageElement
let rects = {}            // assetId -> {rect, dx, dy, rot, scale}
let layout = null         // pose_layout.json
let assetsReady = false

async function boot() {
  const [pngB64, rectsText, layoutText] = await Promise.all([
    dshPet.readAsset('atlas.png'),
    dshPet.readAsset('atlas_rects.json'),
    dshPet.readAsset('pose_layout.json'),
  ])
  const img = new Image()
  img.src = 'data:image/png;base64,' + pngB64
  await new Promise((ok, err) => { img.onload = ok; img.onerror = err })
  atlas = img
  rects = JSON.parse(rectsText).assets || {}
  layout = JSON.parse(layoutText)
  assetsReady = true
  sm.transition(State.IDLE_SLEEP, performance.now())
}

function drawPart(assetId, x, y, rot, scale, alpha) {
  const entry = rects[assetId]
  if (!entry || !entry.rect) return false
  const [sx, sy, sw, sh] = entry.rect
  const s = (entry.scale || 1) * (scale || 1)
  const dx = entry.dx || 0
  const dy = entry.dy || 0
  const r = (entry.rot || 0) + (rot || 0)
  g.save()
  g.translate(x + dx, y + dy)
  if (r) g.rotate(r)
  if (alpha !== undefined) g.globalAlpha = alpha
  g.drawImage(atlas, sx, sy, sw, sh, -sw * s / 2, -sh * s / 2, sw * s, sh * s)
  g.restore()
  return true
}

// 从布局表取部件（带 rects 校准偏移由 drawPart 内部处理）
function P(poseName, id) {
  const pose = layout && layout[poseName]
  return pose && pose.parts ? pose.parts[id] : null
}

// ---------------- 姿态绘制（完全由 pose_layout 的 drawOrder 驱动） ----------------
// 尊重编辑器保存的 hidden / hiddenVfx；写作姿态时手臂与羽毛笔由骨骼链接管（跳过对应部件）
function poseHiddenSet(poseName) {
  const p = layout && layout[poseName]
  return new Set(p && Array.isArray(p.hidden) ? p.hidden : [])
}
function vfxHiddenSet(poseName) {
  const p = layout && layout[poseName]
  return new Set(p && Array.isArray(p.hiddenVfx) ? p.hiddenVfx : [])
}
function drawLayoutParts(poseName, state, anim = null) {
  const pose = layout && layout[poseName]
  if (!pose || !pose.parts) return
  const hidden = poseHiddenSet(poseName)
  const order = Array.isArray(pose.drawOrder) && pose.drawOrder.length ? pose.drawOrder.slice() : Object.keys(pose.parts)
  const seen = new Set()
  const deduped = order.filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
  for (const id of Object.keys(pose.parts)) if (!deduped.includes(id)) deduped.push(id)
  for (const id of deduped) {
    if (hidden.has(id)) continue
    // 写作姿态：手臂/手/羽毛笔由骨骼链与 drawArms 接管（含绑定组的 seg_* 元素）
    if (state === State.WRITING && (id.includes('_upper_arm') || id.includes('_forearm') || id.includes('_hand') || id === 'quill' || id.startsWith('seg_'))) continue
    const part = pose.parts[id]
    if (!part) continue
    let py = part.y
    // 呼吸：只作用配置的 targets
    if (anim && anim.targets && anim.targets.includes(id) && anim.bob) py += anim.bob
    drawPart(id, part.x, py, part.rot || 0, part.scale, 1)
  }
}

// ---------------- 手臂骨骼链 ----------------
// 画面右侧=角色左手(写字, sit_left_*)、画面左侧=角色右手(支撑, sit_right_*)
function segAngle(a, b) { return Math.atan2(b.y - a.y, b.x - a.x) }

function drawArmChain(chain, partIds, now, animate) {
  const hidden = poseHiddenSet('writing')
  const s = chain.shoulder, e = chain.elbow, w = chain.wrist
  let wx = w.x, wy = w.y
  if (animate) {
    // 写字手：快速左右移动（用户要求：手+笔同步快速左右移，幅度大频率快）
    wx += Math.sin(now / 220) * 6.5
    wy += Math.sin(now / 380 + 1.1) * 1.8
  }
  const a1 = segAngle(s, e)
  const a2 = segAngle(e, { x: wx, y: wy })
  const s1 = 0.62
  const s2 = 0.62
  const s3 = 0.55
  if (!hidden.has(partIds.upper)) drawPart(partIds.upper, s.x, s.y, a1 + Math.PI / 2, s1)
  if (!hidden.has(partIds.forearm)) drawPart(partIds.forearm, e.x, e.y, a2 + Math.PI / 2, s2)
  if (!hidden.has(partIds.hand)) drawPart(partIds.hand, wx, wy, a2 + Math.PI / 2, s3)
}

function drawArms(now) {
  const L = layout.writing
  if (!L || !L.parts) return
  const aw = (layout.animation && layout.animation.writing) || {}
  const targets = aw.targets || ['sit_right_hand', 'quill']
  const amp = aw.amplitude !== undefined ? aw.amplitude : 5
  const speed = aw.speed_ms || 220
  const parts = L.parts
  // 移动目标：短距离快速左右平移（seg_* 绑定组元素跟随同频同幅）
  const shakeX = Math.sin(now / speed) * amp
  for (const id of targets) {
    const h = parts[id]
    if (!h) continue
    drawPart(id, h.x + shakeX, h.y, h.rot || 0, h.scale, 1)
  }
  // 其余手部/seg 静止
  for (const id of ['sit_left_hand', 'sit_right_hand']) {
    if (targets.includes(id)) continue
    const h = parts[id]
    if (!h) continue
    drawPart(id, h.x, h.y, h.rot || 0, h.scale, 1)
  }
  for (const id of Object.keys(parts)) {
    if (!id.startsWith('seg_') || targets.includes(id)) continue
    const h = parts[id]
    drawPart(id, h.x, h.y, h.rot || 0, h.scale, 1)
  }
}

// ---------------- VFX ----------------
const zPool = []
const Z_LIFE = 2200
function spawnZ(now) {
  const o = layout && layout.sleep && layout.sleep.vfx ? layout.sleep.vfx.zzz_origin : { x: 235, y: 118 }
  let z = zPool.find((p) => !p.alive)
  if (!z) { z = { alive: false }; zPool.push(z) }
  z.alive = true
  z.born = now
  z.life = Z_LIFE * (0.8 + Math.random() * 0.5)
  z.size = 10 + Math.random() * 8
  z.vx = -14 - Math.random() * 10
  z.vy = -26 - Math.random() * 10
  z.sway = Math.random() * Math.PI * 2
  z.x = o.x + (Math.random() * 16 - 8)
  z.y = o.y + (Math.random() * 8 - 4)
}
let nextZAt = 0

function drawVfxSleep(now, breathPhase) {
  const vfx = layout && layout.sleep ? layout.sleep.vfx : null
  const hidden = vfxHiddenSet('sleep')
  // Z 粒子（对象池）
  if (!hidden.has('zzz_origin')) {
    if (now >= nextZAt) { spawnZ(now); nextZAt = now + 1500 }
    g.save()
    g.textAlign = 'center'; g.textBaseline = 'middle'
    for (const z of zPool) {
      if (!z.alive) continue
      const t = (now - z.born) / z.life
      if (t >= 1) { z.alive = false; continue }
      z.x += z.vx * 0.016
      z.y += z.vy * 0.016
      const alpha = t < 0.7 ? 0.9 : 0.9 * (1 - (t - 0.7) / 0.3)
      const size = z.size * (1 + t * 0.8)
      const sway = Math.sin(now / 380 + z.sway) * 5
      g.font = `800 ${size}px "Segoe UI", "Microsoft YaHei", sans-serif`
      g.fillStyle = `rgba(143,184,232,${alpha})`
      g.fillText('Z', z.x + sway, z.y)
    }
    g.restore()
  }
  // 鼻涕泡（随呼吸 0.85↔1.10 缩放）
  if (vfx && vfx.snot_bubble && !hidden.has('snot_bubble')) {
    const bs = 0.85 + 0.25 * (0.5 + 0.5 * Math.sin(breathPhase))
    drawPart('vfx_snot_bubble', vfx.snot_bubble.x, vfx.snot_bubble.y, 0, bs * (vfx.snot_bubble.scale || 0.7), 0.9)
  }
  // 口水（随呼吸上下微动）
  if (vfx && vfx.drool && !hidden.has('drool')) {
    drawPart('vfx_drool', vfx.drool.x, vfx.drool.y + 2 * Math.sin(breathPhase), 0, vfx.drool.scale || 0.6, 0.85)
  }
}

let popAt = -1
let surprisedUntil = -1
function drawVfxWake(now) {
  const t = now - sm.since
  const d = wakeDurations()
  const vfxSleep = layout && layout.sleep ? layout.sleep.vfx : null
  // 阶段1（pop 时长）：鼻涕泡 → 破裂泡泡 → 迅速消失
  if (t < d.pop && vfxSleep) {
    const pt = t / d.pop
    const b = vfxSleep.bubble_pop || vfxSleep.snot_bubble || { x: 258, y: 236, scale: 0.3 }
    const sc = Math.abs(b.scale) || 0.3
    drawPart('vfx_bubble_pop', b.x, b.y, pt * 0.6, sc * (0.6 + pt * 1.3), 1 - pt)
  }
  // 阶段2/3（pop 后）：惊叹号出现，最后 fade 时长淡出消失
  if (t >= d.pop) {
    const sv = layout && layout.surprised && layout.surprised.vfx ? layout.surprised.vfx.surprise : { x: 359, y: 108, scale: 0.9 }
    const remain = surprisedUntil - now
    const alpha = remain < d.fade ? Math.max(0, remain / d.fade) : 1
    if (alpha > 0) {
      const bob = Math.sin(now / 120) * 4
      drawPart('vfx_surprise', sv.x, sv.y + bob, 0, sv.scale, alpha)
    }
  }
}

// ---------------- 状态进入动作 ----------------
function wakeDurations() {
  const w = (layout.animation && layout.animation.wake) || {}
  return {
    pop: w.pop_ms !== undefined ? w.pop_ms : 350,
    surprise: w.surprise_ms !== undefined ? w.surprise_ms : 600,
    fade: w.fade_ms !== undefined ? w.fade_ms : 400,
  }
}
function onStateEnter(state, now) {
  if (state === State.WAKE_UP) {
    popAt = now
    const d = wakeDurations()
    surprisedUntil = now + d.pop + d.surprise + d.fade
  }
}

// ---------------- 呼吸参数 ----------------
const BREATH_CYCLE = 3200
function breathPhase(now) { return (now % BREATH_CYCLE) / BREATH_CYCLE * Math.PI * 2 }

// ---------------- 动作演示模式（测试循环，setTimeout 链驱动） ----------------
const demo = { active: false, timer: null }
function demoDurations() {
  const d = (layout.animation && layout.animation.demo) || {}
  return {
    sleep: d.sleep_ms !== undefined ? d.sleep_ms : 4000,
    writing: d.writing_ms !== undefined ? d.writing_ms : 6000,
  }
}
function demoLoop() {
  if (!demo.active) return
  const dd = demoDurations()
  // 唤醒
  sm.transition(State.WAKE_UP, performance.now(), true)
  // wake 1.35s 自动转 writing（渲染器内部），writing 持续 writing_ms 后回睡
  demo.timer = setTimeout(() => {
    if (!demo.active) return
    sm.transition(State.RETURN_TO_SLEEP, performance.now(), true)
    // 回睡 1.2s 后自动回 IDLE_SLEEP；再睡 sleep_ms 后进入下一轮
    demo.timer = setTimeout(() => {
      if (!demo.active) return
      demo.timer = setTimeout(() => {
        if (!demo.active) return
        demoLoop()
      }, dd.sleep)
    }, 1600)
  }, 1400 + dd.writing)
}
function toggleDemo() {
  if (demo.active) {
    demo.active = false
    if (demo.timer) { clearTimeout(demo.timer); demo.timer = null }
    sm.transition(State.IDLE_SLEEP, performance.now(), true)
    if (hud) hud.textContent = '动作演示已停止'
    setTimeout(() => { if (hud) hud.textContent = '' }, 1500)
    return
  }
  demo.active = true
  sm.transition(State.IDLE_SLEEP, performance.now(), true)
  if (hud) hud.textContent = '▶ 动作演示循环中（除非再点停止，否则不停止）'
  setTimeout(() => { if (hud) hud.textContent = '' }, 2500)
  // 先睡 sleep_ms 再开始第一轮
  const dd = demoDurations()
  demo.timer = setTimeout(() => { if (demo.active) demoLoop() }, dd.sleep)
}

// ---------------- 主渲染循环 ----------------
let lastFrame = 0
function frame(now) {
  requestAnimationFrame(frame)
  if (!assetsReady || !atlas || !layout) return
  if (sm.state === State.IDLE_SLEEP && now - lastFrame < 66) return
  if (sm.state !== State.IDLE_SLEEP && now - lastFrame < 33) return
  lastFrame = now

  g.clearRect(0, 0, W, H)
  const bp = breathPhase(now)

  if (editor.active) {
    drawEditor()
    return
  }

  switch (sm.state) {
    case State.IDLE_SLEEP: {
      // 呼吸：读 animation.breath 配置（默认 stand_torso 上半身）
      const ab = (layout.animation && layout.animation.breath) || {}
      const targets = ab.targets || ['stand_torso']
      const amp = ab.amplitude !== undefined ? ab.amplitude : 1.6
      const bob = Math.sin(bp) * amp
      drawLayoutParts('sleep', State.IDLE_SLEEP, { bob, targets })
      drawVfxSleep(now, bp)
      break
    }
    case State.WAKE_UP: {
      const t = now - sm.since
      const d = wakeDurations()
      if (t < d.pop) {
        // 阶段1：仍睡眠脸 + 泡泡破裂动画（不画睡眠VFX）
        drawLayoutParts('sleep', State.WAKE_UP)
      } else {
        // 阶段2/3：惊讶脸 + 叹号出现后淡出
        drawLayoutParts('surprised', State.WAKE_UP)
      }
      drawVfxWake(now)
      // 保险：surprisedUntil 异常时兜底，确保能转到 WRITING
      if (surprisedUntil < 0) surprisedUntil = now + 1350
      if (now >= surprisedUntil) sm.transition(State.WRITING, now, true)
      break
    }
    case State.WRITING: {
      // 动作修正（用户要求）：只手+笔同步快速左右移动（drawArms 内），
      // 身体其他部分静止，不再整体晃动
      drawLayoutParts('writing', State.WRITING)
      drawArms(now)
      break
    }
    case State.RETURN_TO_SLEEP: {
      const t = Math.min((now - sm.since) / 1200, 1)
      drawLayoutParts('sleep', State.RETURN_TO_SLEEP)
      drawVfxSleep(now, bp)
      if (t >= 1) sm.transition(State.IDLE_SLEEP, now, true)
      break
    }
    case State.PAUSED: {
      drawLayoutParts('sleep', State.PAUSED)
      break
    }
    case State.ERROR: {
      g.save()
      g.font = '700 18px "Segoe UI", "Microsoft YaHei", sans-serif'
      g.fillStyle = '#ff7a6b'
      g.textAlign = 'center'
      g.fillText('⚠ 任务异常 · 稍作休息', 280, 60)
      g.restore()
      drawLayoutParts('sleep', State.ERROR)
      break
    }
    default: break
  }
}
requestAnimationFrame(frame)

// ---------------- 拖动（编辑模式下拖动部件，否则拖动窗口） ----------------
let dragging = false
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  if (editor.active) {
    editorPointerDown(e)
    return
  }
  dragging = true
  dshPet.dragStart({ x: e.screenX - window.screenX, y: e.screenY - window.screenY })
})
window.addEventListener('mouseup', () => {
  if (dragging) { dragging = false; dshPet.dragEnd() }
  editorPointerUp()
})
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (!editor.active) dshPet.openMenu()
})

// ---------------- 任务桥 + 命令 ----------------
dshPet.onTask((payload) => {
  // 演示模式期间忽略任务桥，防止把 WRITING 秒杀（running=false 会触发回睡）
  if (demo.active) return
  sm.onTask(!!payload.running, performance.now())
})
dshPet.onCommand((payload) => {
  try {
    const { cmd } = payload
    if (cmd === 'pause') { sm.paused = true; sm.transition(State.PAUSED, performance.now()) }
    else if (cmd === 'resume') {
      sm.paused = false
      sm.transition(sm.taskRunning ? State.WAKE_UP : State.IDLE_SLEEP, performance.now())
    }
    else if (cmd === 'calibrate') toggleEditor()
    else if (cmd === 'demo-toggle') toggleDemo()
    else if (cmd === 'reload-layout') {
      assetsReady = false
      editor.active = false
      document.body.classList.remove('calibrating')
      boot().then(() => {
        sm.transition(sm.taskRunning ? State.WAKE_UP : State.IDLE_SLEEP, performance.now())
      }).catch((err) => {
        document.body.classList.add('calibrating')
        hud.textContent = '布局热重载失败: ' + (err && err.message ? err.message : String(err))
      })
    }
  } catch (err) {
    // 可见诊断：任何命令处理错误直接显示在 HUD
    document.body.classList.add('calibrating')
    hud.textContent = '命令处理失败: ' + (err && err.message ? err.message : String(err)) + '\n' + (err && err.stack ? String(err.stack).split('\n').slice(0, 2).join('\n') : '')
  }
})

// ---------------- 可视化编辑器（拖拽摆放部件/VFX/关节，S 保存 pose_layout.json） ----------------
const ALL_PARTS = [
  'chair_back', 'sit_torso',
  'head_sleep', 'head_surprised', 'head_serious',
  'sit_left_upper_arm', 'sit_left_forearm', 'sit_left_hand',
  'sit_right_upper_arm', 'sit_right_forearm', 'sit_right_hand',
  'quill', 'desk', 'ink_bottle',
]
const ALL_VFX = ['snot_bubble', 'drool', 'zzz_origin', 'surprise']
const POSE_LABEL = { sleep: '睡眠 IDLE_SLEEP', surprised: '惊醒 WAKE_UP', writing: '写字 WRITING' }
const editor = {
  active: false,
  pose: 'writing',
  sel: null,        // { kind: 'part'|'vfx'|'joint', id }
  dragging: false,
  dragOX: 0, dragOY: 0,
  dirty: false,
}

function poseParts() {
  const p = layout[editor.pose]
  if (!p.parts) p.parts = {}
  return p.parts
}
function poseVfx() {
  const p = layout[editor.pose]
  if (!p.vfx) p.vfx = {}
  return p.vfx
}
function jointsOf() {
  const p = layout[editor.pose]
  const out = []
  if (p.arm_chain_writing) {
    out.push({ id: 'w_shoulder', kind: 'joint', x: p.arm_chain_writing.shoulder.x, y: p.arm_chain_writing.shoulder.y, label: '写肩' })
    out.push({ id: 'w_elbow', kind: 'joint', x: p.arm_chain_writing.elbow.x, y: p.arm_chain_writing.elbow.y, label: '写肘' })
    out.push({ id: 'w_wrist', kind: 'joint', x: p.arm_chain_writing.wrist.x, y: p.arm_chain_writing.wrist.y, label: '写腕' })
    if (p.arm_chain_writing.quill_tip) out.push({ id: 'w_tip', kind: 'joint', x: p.arm_chain_writing.quill_tip.x, y: p.arm_chain_writing.quill_tip.y, label: '笔尖' })
  }
  if (p.arm_chain_support) {
    out.push({ id: 's_shoulder', kind: 'joint', x: p.arm_chain_support.shoulder.x, y: p.arm_chain_support.shoulder.y, label: '撑肩' })
    out.push({ id: 's_elbow', kind: 'joint', x: p.arm_chain_support.elbow.x, y: p.arm_chain_support.elbow.y, label: '撑肘' })
    out.push({ id: 's_wrist', kind: 'joint', x: p.arm_chain_support.wrist.x, y: p.arm_chain_support.wrist.y, label: '撑腕' })
  }
  return out
}
function getJoint(id) {
  const p = layout[editor.pose]
  const m = { w_shoulder: 'shoulder', w_elbow: 'elbow', w_wrist: 'wrist', w_tip: 'quill_tip' }
  const s = { s_shoulder: 'shoulder', s_elbow: 'elbow', s_wrist: 'wrist' }
  if (id.startsWith('w_') && p.arm_chain_writing) return p.arm_chain_writing[m[id]]
  if (id.startsWith('s_') && p.arm_chain_support) return p.arm_chain_support[s[id]]
  return null
}

// 编辑场景绘制：静态渲染当前姿态 + 选中框 + 关节标记
function drawEditor() {
  const pose = editor.pose
  const isWriting = pose === 'writing'
  drawLayoutParts(pose, isWriting ? State.WRITING : State.IDLE_SLEEP)
  if (isWriting) drawArmsStatic()
  // VFX 标记
  const vfx = poseVfx()
  g.save()
  for (const k of ['snot_bubble', 'drool', 'surprise']) {
    const v = vfx[k]
    if (!v) continue
    const id = k === 'snot_bubble' ? 'vfx_snot_bubble' : k === 'drool' ? 'vfx_drool' : 'vfx_surprise'
    if (k === 'surprise') drawPart(id, v.x, v.y, 0, v.scale, 0.9)
    else drawPart(id, v.x, v.y, 0, v.scale, 0.85)
  }
  if (vfx.zzz_origin) {
    g.fillStyle = 'rgba(143,184,232,0.9)'
    g.font = '700 16px "Segoe UI", sans-serif'
    g.textAlign = 'center'; g.textBaseline = 'middle'
    g.fillText('Z', vfx.zzz_origin.x, vfx.zzz_origin.y)
  }
  // 关节标记（写作姿态）
  for (const j of jointsOf()) {
    g.beginPath()
    g.arc(j.x, j.y, 6, 0, Math.PI * 2)
    g.fillStyle = editor.sel && editor.sel.id === j.id ? '#ff4d6d' : 'rgba(255,190,60,0.9)'
    g.fill()
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1; g.stroke()
  }
  g.restore()
  // 选中框
  if (editor.sel) drawSelection()
}

function drawArmsStatic() {
  const L = layout.writing
  if (!L) return
  if (L.arm_chain_writing) drawArmChain(L.arm_chain_writing, { upper: 'sit_left_upper_arm', forearm: 'sit_left_forearm', hand: 'sit_left_hand' }, 0, false)
  if (L.arm_chain_support) drawArmChain(L.arm_chain_support, { upper: 'sit_right_upper_arm', forearm: 'sit_right_forearm', hand: 'sit_right_hand' }, 0, false)
  if (L.arm_chain_writing && L.arm_chain_writing.quill_tip) {
    const q = L.arm_chain_writing.quill_tip
    drawPart('quill', q.x, q.y, -0.35, 0.9)
  }
}

function selBox() {
  const sel = editor.sel
  if (!sel) return null
  if (sel.kind === 'part') {
    const p = poseParts()[sel.id]
    const e = rects[sel.id]
    if (!p || !e || !e.rect) return null
    const s = p.scale * (e.scale || 1)
    return { x: p.x - e.rect[2] * s / 2, y: p.y - e.rect[3] * s / 2, w: e.rect[2] * s, h: e.rect[3] * s, cx: p.x, cy: p.y }
  }
  if (sel.kind === 'vfx') {
    const v = poseVfx()[sel.id]
    if (!v) return null
    const e = rects[sel.id === 'snot_bubble' ? 'vfx_snot_bubble' : sel.id === 'drool' ? 'vfx_drool' : 'vfx_surprise']
    const w = e && e.rect ? e.rect[2] * v.scale : 40
    const h = e && e.rect ? e.rect[3] * v.scale : 40
    return { x: v.x - w / 2, y: v.y - h / 2, w, h, cx: v.x, cy: v.y }
  }
  const j = getJoint(sel.id)
  if (j) return { x: j.x - 8, y: j.y - 8, w: 16, h: 16, cx: j.x, cy: j.y }
  return null
}

function drawSelection() {
  const b = selBox()
  if (!b) return
  g.save()
  g.strokeStyle = '#ff4d6d'
  g.lineWidth = 2
  g.setLineDash([5, 3])
  g.strokeRect(b.x, b.y, b.w, b.h)
  g.setLineDash([])
  // 中心十字
  g.beginPath()
  g.moveTo(b.cx - 8, b.cy); g.lineTo(b.cx + 8, b.cy)
  g.moveTo(b.cx, b.cy - 8); g.lineTo(b.cx, b.cy + 8)
  g.stroke()
  // 标签
  const label = editor.sel.kind === 'joint' ? getJoint(editor.sel.id) && editor.sel.id : editor.sel.id
  g.font = '600 12px Consolas, monospace'
  g.textAlign = 'center'; g.textBaseline = 'bottom'
  g.fillStyle = '#ff4d6d'
  g.fillText(label, b.cx, b.y - 4)
  g.restore()
}

function hitTest(mx, my) {
  // 关节优先（小目标）
  for (const j of jointsOf()) {
    if (Math.abs(mx - j.x) <= 10 && Math.abs(my - j.y) <= 10) return { kind: 'joint', id: j.id }
  }
  // 部件（绘制顺序反向：后画先中）
  const parts = poseParts()
  const order = ['ink_bottle', 'quill', 'head_sleep', 'head_surprised', 'head_serious', 'sit_torso', 'chair_back', 'desk',
    'sit_left_upper_arm', 'sit_left_forearm', 'sit_left_hand', 'sit_right_upper_arm', 'sit_right_forearm', 'sit_right_hand']
  for (const id of order) {
    const p = parts[id]
    const e = rects[id]
    if (!p || !e || !e.rect) continue
    const s = p.scale * (e.scale || 1)
    const w = e.rect[2] * s, h = e.rect[3] * s
    if (Math.abs(mx - p.x) <= w / 2 && Math.abs(my - p.y) <= h / 2) return { kind: 'part', id }
  }
  // VFX
  const vfx = poseVfx()
  for (const k of ['snot_bubble', 'drool', 'surprise']) {
    const v = vfx[k]
    if (!v) continue
    const e = rects[k === 'snot_bubble' ? 'vfx_snot_bubble' : k === 'drool' ? 'vfx_drool' : 'vfx_surprise']
    const w = e && e.rect ? e.rect[2] * v.scale : 40
    const h = e && e.rect ? e.rect[3] * v.scale : 40
    if (Math.abs(mx - v.x) <= w / 2 && Math.abs(my - v.y) <= h / 2) return { kind: 'vfx', id: k }
  }
  return null
}

function editorPointerDown(e) {
  const rect = canvas.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const hit = hitTest(mx, my)
  editor.sel = hit
  if (hit) {
    editor.dragging = true
    const b = selBox()
    editor.dragOX = b ? mx - b.cx : mx
    editor.dragOY = b ? my - b.cy : my
  }
}
function editorPointerMove(e) {
  if (!editor.active || !editor.dragging || !editor.sel) return
  const rect = canvas.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const nx = Math.min(Math.max(mx - editor.dragOX, 8), W - 8)
  const ny = Math.min(Math.max(my - editor.dragOY, 8), H - 8)
  const sel = editor.sel
  if (sel.kind === 'part') {
    const p = poseParts()[sel.id]
    if (p) { p.x = Math.round(nx); p.y = Math.round(ny) }
  } else if (sel.kind === 'vfx') {
    const v = poseVfx()[sel.id]
    if (v) { v.x = Math.round(nx); v.y = Math.round(ny) }
  } else {
    const j = getJoint(sel.id)
    if (j) { j.x = Math.round(nx); j.y = Math.round(ny) }
  }
  editor.dirty = true
}
function editorPointerUp() {
  editor.dragging = false
}
canvas.addEventListener('mousemove', editorPointerMove)
canvas.addEventListener('wheel', (e) => {
  if (!editor.active || !editor.sel) return
  e.preventDefault()
  const d = e.deltaY < 0 ? 0.03 : -0.03
  const sel = editor.sel
  if (sel.kind === 'part') {
    const p = poseParts()[sel.id]
    if (p) p.scale = Math.max(0.1, Math.round((p.scale + d) * 100) / 100)
  } else if (sel.kind === 'vfx') {
    const v = poseVfx()[sel.id]
    if (v && v.scale !== undefined) v.scale = Math.max(0.1, Math.round((v.scale + d) * 100) / 100)
  }
  editor.dirty = true
}, { passive: false })

function editorHud() {
  const sel = editor.sel
  let line = ''
  if (sel && sel.kind === 'part') {
    const p = poseParts()[sel.id]
    line = ` 选中: ${sel.id}  x=${p ? p.x : '-'} y=${p ? p.y : '-'} scale=${p ? p.scale : '-'} rot=${p ? (p.rot || 0).toFixed(2) : '-'}`
  } else if (sel && sel.kind === 'vfx') {
    const v = poseVfx()[sel.id]
    line = ` 选中VFX: ${sel.id}  x=${v ? v.x : '-'} y=${v ? v.y : '-'}`
  } else if (sel) {
    const j = getJoint(sel.id)
    line = ` 选中关节: ${sel.id}  x=${j ? j.x : '-'} y=${j ? j.y : '-'}`
  } else {
    line = ' （点选部件/关节）'
  }
  const parts = poseParts()
  const missingParts = ALL_PARTS.filter((id) => !parts[id])
  const missingVfx = ALL_VFX.filter((id) => !poseVfx()[id])
  const missing = missingParts.length + missingVfx.length
  return `🎨 可视化编辑器  [姿态: ${POSE_LABEL[editor.pose]}]${line}
[1/2/3] 切换姿态   [鼠标拖] 移动   [滚轮] 缩放   [Q/E] 旋转±3°   [Tab] 轮换选择
[A] 补缺件(还缺${missing}个)   [Delete] 删除选中   [S] 保存 pose_layout.json${editor.dirty ? '（有改动）' : ''}   [C/Esc] 退出`
}

function addMissing() {
  const parts = poseParts()
  const mp = ALL_PARTS.find((id) => !parts[id])
  if (mp) {
    parts[mp] = { x: 280, y: 300, scale: 0.7, rot: 0 }
    editor.sel = { kind: 'part', id: mp }
    editor.dirty = true
    return mp
  }
  const vfx = poseVfx()
  const mv = ALL_VFX.find((id) => !vfx[id])
  if (mv) {
    vfx[mv] = { x: 280, y: 200, scale: 0.7 }
    editor.sel = { kind: 'vfx', id: mv }
    editor.dirty = true
    return mv
  }
  return null
}

function toggleEditor() {
  try {
    editor.active = !editor.active
    editor.sel = null
    editor.dragging = false
    document.body.classList.toggle('calibrating', editor.active)
    if (editor.active) hud.textContent = editorHud()
    else { hud.textContent = ''; sm.transition(sm.taskRunning ? State.WAKE_UP : State.IDLE_SLEEP, performance.now()) }
  } catch (err) {
    document.body.classList.add('calibrating')
    hud.textContent = '编辑器启动失败: ' + (err && err.message ? err.message : String(err)) + '\n' + (err && err.stack ? String(err.stack).split('\n').slice(0, 2).join('\n') : '')
  }
}

function cycleSelect() {
  const parts = poseParts()
  const ids = Object.keys(parts).concat(Object.keys(poseVfx()).map((k) => '@' + k)).concat(jointsOf().map((j) => j.id))
  if (!ids.length) return
  const cur = editor.sel ? (editor.sel.kind === 'vfx' ? '@' + editor.sel.id : editor.sel.id) : ids[0]
  const i = ids.indexOf(cur)
  const next = ids[(i + 1) % ids.length]
  if (next.startsWith('@')) editor.sel = { kind: 'vfx', id: next.slice(1) }
  else if (next.startsWith('w_') || next.startsWith('s_')) editor.sel = { kind: 'joint', id: next }
  else editor.sel = { kind: 'part', id: next }
}

document.addEventListener('keydown', (e) => {
  if (!editor.active) {
    if (e.key === 'c' || e.key === 'C') toggleEditor()
    return
  }
  const sel = editor.sel
  switch (e.key) {
    case '1': editor.pose = 'sleep'; editor.sel = null; break
    case '2': editor.pose = 'surprised'; editor.sel = null; break
    case '3': editor.pose = 'writing'; editor.sel = null; break
    case 'Tab': e.preventDefault(); cycleSelect(); break
    case 'q': case 'Q':
      if (sel && sel.kind === 'part') { const p = poseParts()[sel.id]; if (p) { p.rot = (p.rot || 0) - 0.05; editor.dirty = true } }
      break
    case 'e': case 'E':
      if (sel && sel.kind === 'part') { const p = poseParts()[sel.id]; if (p) { p.rot = (p.rot || 0) + 0.05; editor.dirty = true } }
      break
    case 'a': case 'A': addMissing(); break
    case 'Delete': case 'Backspace':
      if (sel && sel.kind === 'part') { delete poseParts()[sel.id]; editor.sel = null; editor.dirty = true }
      else if (sel && sel.kind === 'vfx') { delete poseVfx()[sel.id]; editor.sel = null; editor.dirty = true }
      break
    case 's': case 'S': {
      dshPet.saveLayout(JSON.stringify(layout, null, 2)).then((r) => {
        editor.dirty = false
        hud.textContent = editorHud() + (r === true ? '\n✓ 已保存 pose_layout.json' : '\n保存失败: ' + r)
      })
      break
    }
    case 'c': case 'C': case 'Escape': toggleEditor(); break
    default: return
  }
  hud.textContent = editorHud()
})

// ---------------- 启动 ----------------
boot().catch((err) => {
  console.error('[dsh-pet] boot failed:', err)
  hud.textContent = '启动失败: ' + err.message
  document.body.classList.add('calibrating')
})
