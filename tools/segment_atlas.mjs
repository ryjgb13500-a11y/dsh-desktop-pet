// tools/segment_atlas.mjs — 纯 Node PNG 解码 + 图集 alpha 分割
// 用法: node tools/segment_atlas.mjs
// 输出: assets/atlas_segments.json（组件 bbox + 颜色统计，按阅读顺序）
//       tools/debug_atlas.html（叠加矩形编号的可视化页面，用于人工校准映射）
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ATLAS = join(ROOT, 'assets', 'character_sprite_atlas.png')

// ---------- PNG 解码 ----------
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png')
  let off = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported png: bitDepth=${bitDepth} colorType=${colorType}`)
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const out = new Uint8Array(width * height * 4)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const prev = y > 0 ? out.subarray((y - 1) * width * 4, y * width * 4) : null
    for (let x = 0; x < stride; x++) {
      const rawByte = line[x]
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      let val
      switch (filter) {
        case 0: val = rawByte; break
        case 1: val = (rawByte + a) & 0xff; break
        case 2: val = (rawByte + b) & 0xff; break
        case 3: val = (rawByte + ((a + b) >> 1)) & 0xff; break
        case 4: val = (rawByte + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`bad filter ${filter}`)
      }
      line[x] = val
      if (bpp === 3) {
        out[y * width * 4 + (x - (x % 3)) * 4 / 3 + (x % 3)] = val
      } else {
        out[y * width * 4 + x] = val
      }
    }
    if (bpp === 3) {
      // 展开 RGB → RGBA
      const src = line
      for (let x = width - 1; x >= 0; x--) {
        out[y * width * 4 + x * 4] = src[x * 3]
        out[y * width * 4 + x * 4 + 1] = src[x * 3 + 1]
        out[y * width * 4 + x * 4 + 2] = src[x * 3 + 2]
        out[y * width * 4 + x * 4 + 3] = 255
      }
    }
  }
  return { width, height, data: out }
}

// ---------- 连通域分割 ----------
const A_MIN = 16
export function segment(png) {
  const { width, height, data } = png
  const label = new Int32Array(width * height).fill(-1)
  const comps = []
  const stack = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (data[i * 4 + 3] <= A_MIN || label[i] >= 0) continue
      // flood fill
      const cid = comps.length
      const comp = { minX: x, minY: y, maxX: x, maxY: y, count: 0, r: 0, g: 0, b: 0, a: 0 }
      stack.push(i)
      label[i] = cid
      while (stack.length) {
        const j = stack.pop()
        const px = j % width, py = (j / width) | 0
        comp.minX = Math.min(comp.minX, px); comp.maxX = Math.max(comp.maxX, px)
        comp.minY = Math.min(comp.minY, py); comp.maxY = Math.max(comp.maxY, py)
        comp.count++
        comp.r += data[j * 4]; comp.g += data[j * 4 + 1]; comp.b += data[j * 4 + 2]; comp.a += data[j * 4 + 3]
        if (px > 0) { const l = j - 1; if (data[l * 4 + 3] > A_MIN && label[l] < 0) { label[l] = cid; stack.push(l) } }
        if (px < width - 1) { const l = j + 1; if (data[l * 4 + 3] > A_MIN && label[l] < 0) { label[l] = cid; stack.push(l) } }
        if (py > 0) { const l = j - width; if (data[l * 4 + 3] > A_MIN && label[l] < 0) { label[l] = cid; stack.push(l) } }
        if (py < height - 1) { const l = j + width; if (data[l * 4 + 3] > A_MIN && label[l] < 0) { label[l] = cid; stack.push(l) } }
      }
      comps.push(comp)
    }
  }
  return comps.map((c) => ({
    x: c.minX, y: c.minY, w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1,
    area: c.count,
    avgColor: [Math.round(c.r / c.count), Math.round(c.g / c.count), Math.round(c.b / c.count)],
  }))
}

function analyze(file) {
  const png = decodePng(readFileSync(file))
  const comps = segment(png).sort((a, b) => (a.y - b.y) || (a.x - b.x))
  console.log(`${file} ${png.width}x${png.height}: ${comps.length} components`)
  comps.forEach((c, i) => {
    console.log(`[${i}] ${c.x},${c.y} ${c.w}x${c.h} area=${c.area} rgb=${c.avgColor.join(',')}`)
  })
  return { png, comps }
}

const MAIN = join(ROOT, 'assets', 'character_sprite_atlas.png')
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === fileURLToPath(new URL('file:///' + process.argv[1].replace(/\\/g, '/'))).toLowerCase()) {
  const { png, comps } = analyze(process.argv[2] || MAIN)
  writeFileSync(join(ROOT, 'assets', 'atlas_segments.json'), JSON.stringify(comps, null, 2))
  const overlay = comps.map((c, i) => {
    const tx = c.x + 2, ty = Math.min(c.y + 12, png.height - 8)
    return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none" stroke="#ff4d6d" stroke-width="1.5"/>
  <text x="${tx}" y="${ty}" font-size="11" fill="#ff4d6d" style="paint-order:stroke" stroke="#ffffff" stroke-width="3">${i}</text>`
  }).join('\n')
  const debugHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Atlas Segment Debug</title>
<style>body{margin:10px;background:#222;color:#eee;font-family:monospace}canvas{border:1px solid #555;background:repeating-conic-gradient(#333 0 25%,#3a3a3a 0 50%) 0 0/24px 24px}</style></head>
<body>
<h3>atlas 组件索引（${comps.length} 个）—— 请把索引对应到 manifest 资产 ID</h3>
<canvas id="c" width="${png.width}" height="${png.height}"></canvas>
<script>
const ATLAS = '../assets/character_sprite_atlas.png'
const SEGS = ${JSON.stringify(comps)}
const img = new Image()
img.onload = () => {
  const cv = document.getElementById('c')
  const g = cv.getContext('2d')
  g.drawImage(img, 0, 0)
  SEGS.forEach((s, i) => {
    g.strokeStyle = '#ff4d6d'; g.lineWidth = 1.5; g.strokeRect(s.x, s.y, s.w, s.h)
    g.fillStyle = '#ff4d6d'; g.strokeStyle = '#fff'; g.lineWidth = 3
    g.strokeText(String(i), s.x + 2, Math.min(s.y + 12, ${png.height} - 8)); g.fillText(String(i), s.x + 2, Math.min(s.y + 12, ${png.height} - 8))
  })
}
img.src = ATLAS
</script>
</body></html>`
  writeFileSync(join(ROOT, 'tools', 'debug_atlas.html'), debugHtml)
  console.log('wrote assets/atlas_segments.json + tools/debug_atlas.html')
}
