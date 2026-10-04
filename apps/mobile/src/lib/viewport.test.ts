// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trackViewport } from './viewport'

class Viewport extends EventTarget {
  height = 780
  offsetTop = 0
  scale = 1
}
let viewport: Viewport
let dispose: (() => void) | undefined
const root = document.documentElement
beforeEach(() => {
  vi.useFakeTimers()
  viewport = new Viewport()
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('innerHeight', 780)
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  root.removeAttribute('style')
  delete root.dataset.keyboard
})
describe('phone viewport', () => {
  it('tracks iOS keyboard shrink and pan, including scroll without resize', () => {
    dispose = trackViewport()
    viewport.height = 430
    viewport.offsetTop = 96
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--ari-mobile-height')).toBe('430px')
    expect(root.style.getPropertyValue('--ari-mobile-top')).toBe('96px')
    expect(root.dataset.keyboard).toBe('open')
    viewport.offsetTop = 122
    viewport.dispatchEvent(new Event('scroll'))
    expect(root.style.getPropertyValue('--ari-mobile-top')).toBe('122px')
    viewport.height = 780
    viewport.offsetTop = 0
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--ari-mobile-top')).toBe('0px')
    expect(root.dataset.keyboard).toBe('closed')
  })
  it('follows Android keyboard resizing without a Safari pan', () => {
    dispose = trackViewport()
    viewport.height = 400
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--ari-mobile-height')).toBe('400px')
    expect(root.style.getPropertyValue('--ari-mobile-top')).toBe('0px')
  })
  it('settles late Safari geometry after focus and dismissal', () => {
    dispose = trackViewport()
    document.dispatchEvent(new Event('focusin'))
    viewport.height = 420
    viewport.offsetTop = 80
    vi.advanceTimersByTime(500)
    expect(root.style.getPropertyValue('--ari-mobile-top')).toBe('80px')
    document.dispatchEvent(new Event('focusout'))
    viewport.height = 780
    viewport.offsetTop = 0
    vi.advanceTimersByTime(500)
    expect(root.style.getPropertyValue('--ari-mobile-height')).toBe('780px')
    expect(root.dataset.keyboard).toBe('closed')
  })
  it('preserves pinch zoom and removes listeners and settling timers', () => {
    dispose = trackViewport()
    viewport.scale = 2
    viewport.height = 200
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--ari-mobile-height')).toBe('780px')
    document.dispatchEvent(new Event('focusin'))
    dispose()
    viewport.scale = 1
    viewport.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(1000)
    expect(root.style.getPropertyValue('--ari-mobile-height')).toBe('780px')
  })
  it('falls back to window resizing when VisualViewport is unavailable', () => {
    vi.stubGlobal('visualViewport', null)
    dispose = trackViewport()
    vi.stubGlobal('innerHeight', 450)
    window.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--ari-mobile-height')).toBe('450px')
    expect(root.style.getPropertyValue('--ari-mobile-top')).toBe('0px')
  })
})
