/**
 * One-off generator for apps/desktop/build/icon.png (512x512).
 * Run: node scripts/gen-icon.mjs
 * Draws the Ari mark: dark rounded square, iris 'A' glyph with accent glow.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const px = new Uint8Array(SIZE * SIZE * 4)

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  const na = a / 255
  px[i] = Math.round(px[i] * (1 - na) + r * na)
  px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na)
  px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na)
  px[i + 3] = Math.max(px[i + 3], Math.round(a))
}

const R = 96 // corner radius
const inside = (x, y) => {
  const cx = Math.min(Math.max(x, R), SIZE - R)
  const cy = Math.min(Math.max(y, R), SIZE - R)
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R || (x >= R && x <= SIZE - R) || (y >= R && y <= SIZE - R)
}

// Background: vertical oklch-ish graphite ramp
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!inside(x, y)) continue
    const t = y / SIZE
    const base = 18 + t * 22
    set(x, y, base, base + 2, base + 8, 255)
  }
}

// Glyph: thick 'A' as two diagonals + crossbar, iris gradient along Y
function diag(x0, y0, x1, y1, thickness, colorAt) {
  const steps = 1200
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const cx = x0 + (x1 - x0) * t
    const cy = y0 + (y1 - y0) * t
    const [r, g, b] = colorAt(cy / SIZE)
    for (let dx = -thickness / 2; dx <= thickness / 2; dx++) {
      for (let dy = -thickness / 2; dy <= thickness / 2; dy++) {
        if (dx * dx + dy * dy <= (thickness / 2) ** 2) {
          set(Math.round(cx + dx), Math.round(cy + dy), r, g, b, 255)
        }
      }
    }
  }
}

const iris = (t) => {
  const hueShift = t * 30
  return [
    Math.round(110 + hueShift),
    Math.round(95 + t * 40),
    Math.round(240 - t * 20),
  ]
}

diag(150, 400, 256, 112, 46, iris) // left stroke
diag(362, 400, 256, 112, 46, iris) // right stroke
diag(186, 292, 326, 292, 38, iris) // crossbar

// Soft glow behind glyph: additive halo passes
for (let pass = 6; pass >= 1; pass--) {
  const spread = pass * 7
  const alpha = 10
  for (let y = 80; y < 440; y += 3) {
    for (let x = 130; x < 384; x += 3) {
      const t = y / SIZE
      const [r, g, b] = iris(t)
      const inGlyph =
        (Math.abs((x - 150) / -1.06 - (y - 400)) < spread + 24 ||
          Math.abs((x - 362) / 1.06 - (y - 400)) < spread + 24 ||
          (y > 278 && y < 306 && x > 170 && x < 342)) &&
        inside(x, y)
      if (inGlyph) set(x, y, r, g, b, alpha)
    }
  }
}

// Encode PNG
const crcTable = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = join(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/build/icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log(`wrote ${out} (${png.length} bytes)`)
