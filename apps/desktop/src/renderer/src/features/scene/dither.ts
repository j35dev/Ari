/**
 * The scene's dissolve. The art is drawn sharp, then broken up with an 8x8
 * ordered dither whose threshold falls toward the bottom of the stage, so the
 * picture ends as scattered squares rather than at an edge or a blur.
 */

/** 8x8 Bayer matrix, values 0..63. */
const BAYER_8 = [
  0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52, 11, 59, 7, 55, 40, 24,
  36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61, 34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6,
  54, 9, 57, 5, 53, 42, 26, 38, 22, 41, 25, 37, 21,
] as const

/** Where the picture is whole, and where it is gone, as fractions of height. */
const SOLID_UNTIL = 0.16
const GONE_BY = 0.72
/** How far the art sinks into the page colour before it breaks up. */
const SINK_FROM = 0.1
const SINK_TO = 0.64
const SINK_DEPTH = 0.68
/** CSS pixels per dither cell. */
const CELL = 2.4
/** A full-window canvas at high DPI is more pixels than the effect needs. */
const MAX_EDGE = 2400

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

/** The ordered-dither threshold for a cell, in (0, 1). */
export function ditherThreshold(cellX: number, cellY: number): number {
  return (BAYER_8[(cellY & 7) * 8 + (cellX & 7)]! + 0.5) / 64
}

/**
 * How much of the picture survives at height `v` (0 top, 1 bottom) for a cell
 * of luminance `lum` (0..1). Bright parts of the art last longer, so the
 * dissolve follows the picture instead of cutting straight across it.
 */
export function sceneCoverage(v: number, lum: number): number {
  const base = 1 - smoothstep(SOLID_UNTIL, GONE_BY, v)
  return Math.min(1, base + (lum - 0.42) * 0.9 * (1 - base) * base * 2.2)
}

/** How far the art is mixed toward the page colour at height `v`. */
export function sceneSink(v: number): number {
  return smoothstep(SINK_FROM, SINK_TO, v) * SINK_DEPTH
}

/** Resolves any CSS colour to RGB through a 1x1 canvas. */
function resolveColor(color: string): [number, number, number] | null {
  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return null
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [r ?? 0, g ?? 0, b ?? 0]
}

/**
 * Paints `image` into `canvas` as the dithered scene. `page` is the colour the
 * art dissolves into (the stage background). Returns false when there is
 * nothing to paint yet: no layout, no 2D context, or an undecoded image.
 */
export function paintDitherScene(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  page: string,
): boolean {
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  if (cssWidth === 0 || cssHeight === 0 || image.naturalWidth === 0) return false

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const scale = Math.min(dpr, MAX_EDGE / Math.max(cssWidth, cssHeight))
  const width = Math.max(1, Math.round(cssWidth * scale))
  const height = Math.max(1, Math.round(cssHeight * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return false
  const sink = resolveColor(page)
  if (sink === null) return false

  canvas.width = width
  canvas.height = height

  // Cover-fit the art into the upper part of the stage, anchored to its middle.
  const artHeight = height * 0.82
  const fit = Math.max(width / image.naturalWidth, artHeight / image.naturalHeight)
  const drawWidth = image.naturalWidth * fit
  const drawHeight = image.naturalHeight * fit
  ctx.drawImage(image, (width - drawWidth) / 2, (artHeight - drawHeight) / 2, drawWidth, drawHeight)

  const cell = Math.max(2, Math.round(CELL * scale))
  const pixels = ctx.getImageData(0, 0, width, height)
  const data = pixels.data
  const [sinkR, sinkG, sinkB] = sink

  for (let cellY = 0; cellY * cell < height; cellY++) {
    const top = cellY * cell
    const bottom = Math.min(height, top + cell)
    const v = top / height
    const mix = sceneSink(v)
    for (let cellX = 0; cellX * cell < width; cellX++) {
      const left = cellX * cell
      const right = Math.min(width, left + cell)
      const first = (top * width + left) * 4
      const lum =
        (0.2126 * data[first]! + 0.7152 * data[first + 1]! + 0.0722 * data[first + 2]!) / 255
      const keep = sceneCoverage(v, lum) > ditherThreshold(cellX, cellY)
      for (let y = top; y < bottom; y++) {
        let i = (y * width + left) * 4
        for (let x = left; x < right; x++, i += 4) {
          if (!keep) {
            data[i + 3] = 0
          } else if (mix > 0) {
            data[i] = data[i]! + (sinkR - data[i]!) * mix
            data[i + 1] = data[i + 1]! + (sinkG - data[i + 1]!) * mix
            data[i + 2] = data[i + 2]! + (sinkB - data[i + 2]!) * mix
          }
        }
      }
    }
  }
  ctx.putImageData(pixels, 0, 0)
  return true
}
