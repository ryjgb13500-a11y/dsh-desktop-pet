// tools/make_icon.mjs — 从 atlas 的蓝色 VFX 件生成托盘图标（纯 Node PNG 编码）
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './segment_atlas.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// crc32
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const atlas = decodePng(readFileSync(join(ROOT, 'assets', 'character_sprite_atlas.png')))
// 源区域：蓝色 Z 件（vfx_sleep_z 候选 [597,784,84,86]）——取 atlas 中蓝色像素最密集的 84x86 区域
const src = [597, 784, 84, 86]
const SIZE = 32
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const sx = src[0] + Math.floor(x / SIZE * src[2])
    const sy = src[1] + Math.floor(y / SIZE * src[3])
    const sp = (sy * atlas.width + sx) * 4
    const dp = (y * SIZE + x) * 4
    out[dp] = atlas.data[sp]; out[dp + 1] = atlas.data[sp + 1]
    out[dp + 2] = atlas.data[sp + 2]; out[dp + 3] = atlas.data[sp + 3]
  }
}
writeFileSync(join(ROOT, 'assets', 'tray-icon.png'), encodePng(SIZE, SIZE, out))
console.log('wrote assets/tray-icon.png')
