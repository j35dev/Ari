import { registerOverlay } from '@ari/ui/overlay-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { overlaps, watchOverlays } from './overlay-cover'

const box = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

const HOST = box(800, 100, 400, 600)

describe('overlaps', () => {
  it('counts a scrim, a menu reaching over an edge, and a shadow just touching it', () => {
    expect(overlaps(HOST, box(0, 0, 1600, 900))).toBe(true)
    expect(overlaps(HOST, box(700, 300, 150, 200))).toBe(true)
    expect(overlaps(HOST, box(600, 300, 196, 50))).toBe(true)
  })

  it('ignores surfaces clear of it and anything without a box', () => {
    expect(overlaps(HOST, box(0, 0, 700, 900))).toBe(false)
    expect(overlaps(HOST, box(900, 300, 0, 0))).toBe(false)
    expect(overlaps(box(0, 0, 0, 0), box(0, 0, 1600, 900))).toBe(false)
  })
})

describe('watchOverlays', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('follows a menu that mounts clear of the page and then settles over it', async () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const host = document.createElement('div')
    host.getBoundingClientRect = () => HOST
    const menu = document.createElement('div')
    let menuBox = box(0, 0, 200, 300)
    menu.getBoundingClientRect = () => menuBox
    const onChange = vi.fn()
    const stop = watchOverlays(host, onChange)

    const release = registerOverlay(menu)
    await Promise.resolve()
    expect(onChange).not.toHaveBeenCalled()

    menuBox = box(900, 200, 200, 300)
    frames.shift()?.(0)
    expect(onChange).toHaveBeenLastCalledWith(true)

    release()
    await Promise.resolve()
    expect(onChange).toHaveBeenLastCalledWith(false)
    stop()
  })
})
