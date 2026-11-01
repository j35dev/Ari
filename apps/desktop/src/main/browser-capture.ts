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
 */
export function encodeCapture(
  image: CapturedImage,
  format: 'png' | 'jpeg',
  size?: CaptureSize,
): Buffer | null {
  const current = image.getSize()
  const sized =
    size !== undefined &&
    size.width > 0 &&
    size.height > 0 &&
    (current.width !== size.width || current.height !== size.height)
      ? image.resize({ width: size.width, height: size.height })
      : image
  const encoded = format === 'jpeg' ? sized.toJPEG(80) : sized.toPNG()
  return encoded.length > 0 ? encoded : null
}
