/*
 * Renders the PWA raster icons from the desktop's 1024px PNG.
 *
 * Node builtins only, no image libraries: the source is 8-bit RGBA,
 * non-interlaced, so decoding is inflate plus scanline unfiltering, and
 * encoding is filter-zero rows plus deflate. Outputs are committed to
 * `public/` — regeneration is a maintainer step, never part of the build.
 *
 * iOS ignores SVG home-screen icons, which is why PNGs exist at all. The
 * maskable icon centres the mark inside the safe zone on the obsidian
 * background the SVGs already use; the apple-touch icon is flattened opaque
 * because iOS paints black behind transparency.
 */

import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = join(here, '..')
const source = join(mobileRoot, '..', '..', 'apps', 'desktop', 'build', 'icon.png')
const outDir = join(mobileRoot, 'public')

/** The obsidian background, shared with the SVGs and the theme-color. */
const BACKGROUND = [0x13, 0x13, 0x20]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'latin1')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length, 0)
  const trailer = Buffer.alloc(4)
  trailer.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([header, typeBytes, data, trailer])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decodes an 8-bit RGBA non-interlaced PNG into rows of [r,g,b,a]. */
function decodePng(file) {
  const bytes = readFileSync(file)
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`not a PNG: ${file}`)
  }
  let width = 0
  let height = 0
  const idat = []
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error(`unsupported PNG format in ${file} (need 8-bit RGBA, no interlace)`)
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[i - 4] : 0
      const b = previous[i]
      const c = i >= 4 ? previous[i - 4] : 0
      const value = row[i]
      out[i] =
        filter === 0
          ? value
          : filter === 1
            ? (value + a) & 0xff
            : filter === 2
              ? (value + b) & 0xff
              : filter === 3
                ? (value + ((a + b) >> 1)) & 0xff
                : (value + paeth(a, b, c)) & 0xff
    }
    previous = Buffer.from(out)
  }
  return { width, height, pixels }
}

/**
 * Box-filter downscale in premultiplied space, so translucent edges average
 * against transparency rather than against black.
 */
function downscale(image, size) {
  const scale = image.width / size
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.min(image.width, Math.ceil((x + 1) * scale))
      const y0 = Math.floor(y * scale)
      const y1 = Math.min(image.height, Math.ceil((y + 1) * scale))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4
          const alpha = image.pixels[i + 3] / 255
          r += image.pixels[i] * alpha
          g += image.pixels[i + 1] * alpha
          b += image.pixels[i + 2] * alpha
          a += alpha
        }
      }
      const n = (x1 - x0) * (y1 - y0)
      const o = (y * size + x) * 4
      if (a === 0) {
        out[o + 3] = 0
      } else {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round((a / n) * 255)
      }
    }
  }
  return { width: size, height: size, pixels: out }
}

/** Flattens onto an opaque background; a no-op where already opaque. */
function flatten(image, background) {
  const out = Buffer.from(image.pixels)
  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3] / 255
    out[i] = Math.round(out[i] * alpha + background[0] * (1 - alpha))
    out[i + 1] = Math.round(out[i + 1] * alpha + background[1] * (1 - alpha))
    out[i + 2] = Math.round(out[i + 2] * alpha + background[2] * (1 - alpha))
    out[i + 3] = 255
  }
  return { width: image.width, height: image.height, pixels: out }
}

/** Centres a smaller copy on an opaque background of the icon's own size. */
function padToSafeZone(image, ratio) {
  const inner = Math.round(image.width * ratio)
  const small = downscale(image, inner)
  const flat = flatten(small, BACKGROUND)
  const out = Buffer.alloc(image.width * image.height * 4)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = BACKGROUND[0]
    out[i + 1] = BACKGROUND[1]
    out[i + 2] = BACKGROUND[2]
    out[i + 3] = 255
  }
  const at = Math.floor((image.width - inner) / 2)
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const from = (y * inner + x) * 4
      const to = ((y + at) * image.width + (x + at)) * 4
      out[to] = flat.pixels[from]
      out[to + 1] = flat.pixels[from + 1]
      out[to + 2] = flat.pixels[from + 2]
      out[to + 3] = 255
    }
  }
  return { width: image.width, height: image.height, pixels: out }
}

function encodePng(image) {
  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0
    image.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(image.width, 0)
  ihdr.writeUInt32BE(image.height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const master = decodePng(source)
if (master.width !== master.height || master.width < 512) {
  throw new Error(`expected a square source of at least 512px, got ${master.width}x${master.height}`)
}

const targets = [
  { name: 'icon-512.png', image: downscale(master, 512) },
  { name: 'icon-192.png', image: downscale(master, 192) },
  { name: 'icon-maskable.png', image: padToSafeZone(downscale(master, 512), 0.8) },
  { name: 'apple-touch-icon.png', image: flatten(downscale(master, 180), BACKGROUND) },
]

mkdirSync(outDir, { recursive: true })
for (const target of targets) {
  const bytes = encodePng(target.image)
  writeFileSync(join(outDir, target.name), bytes)
  process.stdout.write(
    `${target.name}: ${target.image.width}x${target.image.height}, ${bytes.length} bytes\n`,
  )
}
