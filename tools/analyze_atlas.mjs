// tools/analyze_atlas.mjs — 按颜色桶统计每个组件的像素签名，辅助资产 ID 映射
// 用法: node tools/analyze_atlas.mjs
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, segment } from './segment_atlas.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ATLAS = join(ROOT, 'assets', 'character_sprite_atlas.png')

function bucket(r, g, b) {
  const sum = r + g + b
  if (sum < 260) return 'dark'          // 深色（黑裙/阴影）
  if (sum > 620) return 'white'         // 白色（女仆装/纸）
  if (b > 150 && b > r + 40 && b > g + 20) return 'blue'    // 蓝发/蓝 VFX
  if (r > 180 && g > 120 && g < 210 && b > 110 && b < 210 && r > g + 15 && r > b + 15) return 'skin' // 皮肤
  if (r > 110 && g > 60 && g < 190 && b < 120 && r > b + 40) return 'brown'  // 木色/棕
  if (r > 180 && g > 100 && g < 190 && b < 115) return 'orange' // 橙（羽毛笔/琥珀）
  if (g > 150 && b > 150 && r < 170) return 'cyan'    // 浅蓝青
  return 'other'
}

const png = decodePng(readFileSync(ATLAS))
const comps = segment(png).sort((a, b) => (a.y - b.y) || (a.x - b.x))
const rows = comps.map((c, i) => {
  const stats = { dark: 0, white: 0, blue: 0, skin: 0, brown: 0, orange: 0, cyan: 0, other: 0 }
  const top = { skin: 0, blue: 0 }
  const midY = c.y + (c.h / 2 | 0)
  let n = 0
  for (let y = c.y; y < c.y + c.h; y++) {
    for (let x = c.x; x < c.x + c.w; x++) {
      const p = (y * png.width + x) * 4
      if (png.data[p + 3] <= 16) continue
      const b = bucket(png.data[p], png.data[p + 1], png.data[p + 2])
      stats[b]++
      n++
      if (y < midY) { if (b === 'skin') top.skin++; if (b === 'blue') top.blue++ }
    }
  }
  const pct = (k) => ((stats[k] / n) * 100).toFixed(0) + '%'
  return {
    idx: i,
    rect: `${c.x},${c.y} ${c.w}x${c.h}`,
    skin: pct('skin'), blue: pct('blue'), dark: pct('dark'), white: pct('white'),
    brown: pct('brown'), orange: pct('orange'), cyan: pct('cyan'),
    topSkin: ((top.skin / n) * 100).toFixed(0) + '%', topBlue: ((top.blue / n) * 100).toFixed(0) + '%',
    area: c.area,
  }
})
console.log('idx | rect          | skin  blue  dark  white brown orang cyan | topSkin/topBlue | area')
rows.forEach((r) => {
  console.log(
    `${String(r.idx).padStart(3)} | ${r.rect.padEnd(13)} | ${r.skin.padStart(4)} ${r.blue.padStart(5)} ${r.dark.padStart(5)} ${r.white.padStart(5)} ${r.brown.padStart(5)} ${r.orange.padStart(5)} ${r.cyan.padStart(4)} | ${r.topSkin}/${r.topBlue} | ${r.area}`
  )
})
