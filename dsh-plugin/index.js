// dsh-desktop-pet 宿主半：桌面宠物生命周期 + 任务状态桥 + 网页化编辑器服务
// - DSH 启动 → 拉起 Electron 桌面宠物（自动重试 ≤3 次）
// - /pet/status → { running, layoutRev } 任务桥（宠物每 250ms 轮询；layoutRev 变化触发宠物热重载布局）
// - /pet/editor/ → 网页化可视化编辑器（PPT/Flash 式：素材库拖入画布 + 属性面板 + 姿态切换）
// - /pet/editor-data → 编辑器一次性数据（atlas base64 + rects + layout）
// - /pet/save-layout、/pet/save-rects → POST 保存 JSON 到项目 assets
// - DSH 关闭 → 终止宠物进程（宠物侧 --watch 模式也会在 DSH 失联后自行退出）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const name = 'dsh-desktop-pet'
export const inject = ['agents', 'webServer', 'subprocess', 'timer']

// 插件目录的上一级 = DSH-Desktop-Pet 项目根（插件约定放在 <root>/dsh-plugin 内）
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_RETRY = 3

function json(res, data, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(data))
}
function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((ok, err) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) { err(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')))
    req.on('error', err)
  })
}

export function apply(ctx, config) {
  const cfg = config || {}
  const appDir = typeof cfg.appDir === 'string' && cfg.appDir ? cfg.appDir : APP_ROOT
  const assetsDir = join(appDir, 'assets')
  const editorDir = join(appDir, 'editor')
  const layoutFile = join(assetsDir, 'pose_layout.json')
  const rectsFile = join(assetsDir, 'atlas_rects.json')

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
  }
  // 布局文件指纹（宠物轮询到变化后热重载，无需重启进程）
  const layoutRev = () => {
    try { return createHash('sha1').update(readFileSync(layoutFile)).digest('hex').slice(0, 16) } catch { return '' }
  }

  // ---------- 任务状态桥 ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/pet/status',
    handler: (_req, res) => {
      let running = false
      let count = 0
      try {
        for (const agent of ctx.agents.list()) {
          count++
          if (agent.status === 'running') { running = true; break }
        }
      } catch { /* agents 不可用时按空闲处理 */ }
      json(res, { running, sessions: count, ts: Date.now(), layoutRev: layoutRev() })
    },
  }), 'dsh-desktop-pet: /pet/status')

  // ---------- 编辑器静态页面（/pet/editor/ 前缀） ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pet/editor/',
    handler: (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const rel = pathname.slice('/pet/editor/'.length) || 'index.html'
      if (rel.includes('..') || rel.includes('\\')) { json(res, { error: 'bad path' }, 400); return }
      const dot = rel.lastIndexOf('.')
      const mime = dot >= 0 ? MIME[rel.slice(dot)] : MIME['.html']
      try {
        const buf = readFileSync(join(editorDir, rel))
        res.writeHead(200, { 'content-type': mime || 'application/octet-stream', 'cache-control': 'no-cache' })
        res.end(buf)
      } catch {
        json(res, { error: 'not found' }, 404)
      }
    },
  }), 'dsh-desktop-pet: /pet/editor/')

  // ---------- 编辑器一次性数据 ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/pet/editor-data',
    handler: (_req, res) => {
      try {
        json(res, {
          atlas: readFileSync(join(assetsDir, 'character_sprite_atlas.png')).toString('base64'),
          rects: JSON.parse(readFileSync(rectsFile, 'utf8')),
          layout: JSON.parse(readFileSync(layoutFile, 'utf8')),
          layoutRev: layoutRev(),
        })
      } catch (e) {
        json(res, { error: String((e && e.message) || e) }, 500)
      }
    },
  }), 'dsh-desktop-pet: /pet/editor-data')

  // ---------- 保存端点（POST JSON body） ----------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/pet/save-layout',
    handler: async (req, res) => {
      try {
        const parsed = JSON.parse(await readBody(req))
        writeFileSync(layoutFile, JSON.stringify(parsed, null, 2))
        json(res, { ok: true, layoutRev: layoutRev() })
      } catch (e) {
        json(res, { ok: false, error: String((e && e.message) || e) }, 400)
      }
    },
  }), 'dsh-desktop-pet: /pet/save-layout')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/pet/save-rects',
    handler: async (req, res) => {
      try {
        const parsed = JSON.parse(await readBody(req))
        writeFileSync(rectsFile, JSON.stringify(parsed, null, 2))
        json(res, { ok: true })
      } catch (e) {
        json(res, { ok: false, error: String((e && e.message) || e) }, 400)
      }
    },
  }), 'dsh-desktop-pet: /pet/save-rects')

  // ---------- 宠物进程生命周期 ----------
  let petHandle = null
  let disposed = false
  let attempt = 0

  const electronExe = join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  const spawnPet = async () => {
    if (disposed) return null
    if (!existsSync(electronExe)) {
      console.warn(`[dsh-desktop-pet] electron not found: ${electronExe} (先运行 npm install)`)
      return null
    }
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [electronExe, appDir, '--watch'],
        cwd: appDir,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        graceMs: 3000,
      })
    } catch (e) {
      console.warn('[dsh-desktop-pet] spawn failed:', String((e && e.message) || e))
      return null
    }
    // 3 秒内死亡 → 重试（≤3 次）
    const earlyDeath = await Promise.race([
      handle.done.then(() => true).catch(() => true),
      ctx.timeout(3000).then(() => false),
    ])
    if (earlyDeath && !disposed) {
      attempt++
      console.warn(`[dsh-desktop-pet] pet exited early (attempt ${attempt}/${MAX_RETRY})`)
      if (attempt < MAX_RETRY) {
        await ctx.timeout(1000)
        return spawnPet()
      }
      return null
    }
    return handle
  }

  ctx.effect(() => {
    spawnPet().then((h) => {
      if (h) petHandle = h
    })
    return () => {
      disposed = true
      if (petHandle) {
        try { petHandle.terminate() } catch { }
        petHandle = null
      }
    }
  }, 'dsh-desktop-pet: lifecycle')
}
