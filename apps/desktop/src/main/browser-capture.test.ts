import { describe, expect, it, vi } from 'vitest'
import { encodeCapture, type CapturedImage } from './browser-capture'

function image(
  width: number,
  height: number,
): CapturedImage & { resize: ReturnType<typeof vi.fn> } {
  const self = {
    getSize: () => ({ width, height }),
    resize: vi.fn((size: { width: number; height: number }) => image(size.width, size.height)),
    toJPEG: () => Buffer.from(`jpeg ${String(width)}x${String(height)}`),
    toPNG: () => Buffer.from(`png ${String(width)}x${String(height)}`),
  }
  return self
}

describe('encodeCapture', () => {
  it('scales a 2x device-pixel capture down to the CSS viewport size', () => {
    const shot = encodeCapture(image(1280, 1024), 'jpeg', { width: 640, height: 512 })
    expect(shot?.toString()).toBe('jpeg 640x512')
  })

  it('leaves the image alone when it is already the requested size', () => {
    const capture = image(800, 600)
    expect(encodeCapture(capture, 'jpeg', { width: 800, height: 600 })?.toString()).toBe(
      'jpeg 800x600',
    )
    expect(capture.resize).not.toHaveBeenCalled()
  })

  it('keeps device pixels and the format when no size is asked for', () => {
    const capture = image(200, 100)
    expect(encodeCapture(capture, 'png')?.toString()).toBe('png 200x100')
    expect(capture.resize).not.toHaveBeenCalled()
  })

  it('never scales above the capture when the page reports a huge viewport', () => {
    const capture = image(800, 600)
    const shot = encodeCapture(capture, 'jpeg', { width: 1e6, height: 1e6 })
    expect(shot?.toString()).toBe('jpeg 800x600')
    expect(capture.resize).not.toHaveBeenCalled()
  })

  it('clamps each side to the capture', () => {
    const capture = image(1280, 1024)
    expect(encodeCapture(capture, 'jpeg', { width: 640, height: 1e6 })?.toString()).toBe(
      'jpeg 640x1024',
    )
    expect(capture.resize).toHaveBeenCalledWith({ width: 640, height: 1024 })
  })

  it.each([
    [Number.NaN, 600],
    [Number.POSITIVE_INFINITY, 600],
    [800, -1],
    [0, 600],
  ])('does not resize for a reported viewport of %s x %s', (width, height) => {
    const capture = image(800, 600)
    expect(encodeCapture(capture, 'jpeg', { width, height })?.toString()).toBe('jpeg 800x600')
    expect(capture.resize).not.toHaveBeenCalled()
  })

  it('returns null for an empty capture', () => {
    const empty: CapturedImage = { ...image(0, 0), toPNG: () => Buffer.alloc(0) }
    expect(encodeCapture(empty, 'png')).toBeNull()
  })
})
