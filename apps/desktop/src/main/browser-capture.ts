/** The parts of Electron's NativeImage a capture needs. */
export interface CapturedImage {
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number }): CapturedImage
  toJPEG(quality: number): Buffer
  toPNG(): Buffer
}

export interface CaptureSize {
  width: number
  height: number
}

/**
 * Encodes a captured page. capturePage returns device pixels, so on a HiDPI
 * screen the image is scale times the CSS viewport. With `size`, the image is
 * scaled to it so its pixels are the CSS px browser_pointer takes.
 *
 * `size` comes from the page (innerWidth/innerHeight), which a page can set to
 * anything, so it only ever scales down: each side is clamped to the capture,
 * and a non-finite or non-positive size leaves the image alone.
 */
export function encodeCapture(
  image: CapturedImage,
  format: 'png' | 'jpeg',
  size?: CaptureSize,
): Buffer | null {
  const current = image.getSize()
  const target = size === undefined ? null : clampSize(size, current)
  const sized =
    target !== null && (current.width !== target.width || current.height !== target.height)
      ? image.resize(target)
      : image
  const encoded = format === 'jpeg' ? sized.toJPEG(80) : sized.toPNG()
  return encoded.length > 0 ? encoded : null
}

function clampSize(size: CaptureSize, bound: CaptureSize): CaptureSize | null {
  const valid = (n: number): boolean => Number.isFinite(n) && n > 0
  if (!valid(size.width) || !valid(size.height)) return null
  const width = Math.min(Math.round(size.width), bound.width)
  const height = Math.min(Math.round(size.height), bound.height)
  return width > 0 && height > 0 ? { width, height } : null
}
