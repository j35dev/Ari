import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAKE_SCALE,
  bakePlan,
  coverRect,
  installWallpaperBake,
  RESIZE_SETTLE_MS,
  WALLPAPER_BLUR_PX,
} from './wallpaper-bake'

describe('coverRect', () => {
  it('fills the box and centres the overflow, like background-size: cover', () => {
    // A 16:9 image in a square box overflows sideways.
    expect(coverRect(1600, 900, 450, 450)).toEqual({ x: -175, y: 0, width: 800, height: 450 })
    // A tall box crops top and bottom of a square image.
    expect(coverRect(100, 100, 50, 200)).toEqual({ x: -75, y: 0, width: 200, height: 200 })
    expect(coverRect(100, 100, 200, 50)).toEqual({ x: 0, y: -75, width: 200, height: 200 })
  })
})

describe('bakePlan', () => {
  it('bakes at reduced resolution with the blur scaled to match', () => {
    const plan = bakePlan(1280, 800)
    expect(plan.width).toBe(1280 * BAKE_SCALE)
    expect(plan.height).toBe(800 * BAKE_SCALE)
    expect(plan.blur * (1 / BAKE_SCALE)).toBe(WALLPAPER_BLUR_PX)
  })

  it('mirrors at least three standard deviations past each edge', () => {
    const plan = bakePlan(1280, 800)
    expect(plan.margin).toBeGreaterThanOrEqual(plan.blur * 3)
  })

  it('never plans an empty canvas', () => {
    expect(bakePlan(0, 0)).toMatchObject({ width: 1, height: 1 })
  })
})

describe('installWallpaperBake', () => {
  const root = document.documentElement
  const baked = (): string => root.style.getPropertyValue('--ari-wallpaper-baked')
  const flagged = (): boolean => 'ariWallpaperBaked' in root.dataset

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('innerWidth', 1280)
    vi.stubGlobal('innerHeight', 800)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('flags the root with the baked URL once the bake lands', async () => {
    const bake = vi.fn(() => Promise.resolve('blob:one'))
    const dispose = installWallpaperBake(root, '/scene.jpg', { bake, revoke: vi.fn() })

    expect(bake).toHaveBeenCalledWith('/scene.jpg', 1280, 800)
    expect(flagged()).toBe(false)
    await vi.waitFor(() => expect(flagged()).toBe(true))
    expect(baked()).toBe('url("blob:one")')
    dispose()
  })

  it('re-bakes once a resize settles and revokes the URL it replaces', async () => {
    const urls = ['blob:one', 'blob:two']
    const bake = vi.fn(() => Promise.resolve(urls.shift()!))
    const revoke = vi.fn()
    const dispose = installWallpaperBake(root, '/scene.jpg', { bake, revoke })
    await vi.waitFor(() => expect(baked()).toBe('url("blob:one")'))

    vi.stubGlobal('innerWidth', 1600)
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(bake).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(RESIZE_SETTLE_MS)
    expect(bake).toHaveBeenCalledTimes(2)
    expect(bake).toHaveBeenLastCalledWith('/scene.jpg', 1600, 800)

    await vi.waitFor(() => expect(baked()).toBe('url("blob:two")'))
    expect(revoke).toHaveBeenCalledWith('blob:one')
    dispose()
  })

  it('skips a resize that ends at the size already baked', async () => {
    const bake = vi.fn(() => Promise.resolve('blob:one'))
    const dispose = installWallpaperBake(root, '/scene.jpg', { bake, revoke: vi.fn() })
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(RESIZE_SETTLE_MS)
    expect(bake).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('drops a bake that finishes after teardown', async () => {
    let finish: (url: string) => void = () => undefined
    const bake = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)))
    const revoke = vi.fn()
    const dispose = installWallpaperBake(root, '/scene.jpg', { bake, revoke })
    dispose()
    finish('blob:late')
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:late'))
    expect(flagged()).toBe(false)
    expect(baked()).toBe('')
  })

  it('clears the flag on teardown so the next scene never shows this one', async () => {
    const revoke = vi.fn()
    const dispose = installWallpaperBake(root, '/scene.jpg', {
      bake: () => Promise.resolve('blob:one'),
      revoke,
    })
    await vi.waitFor(() => expect(flagged()).toBe(true))
    dispose()
    expect(flagged()).toBe(false)
    expect(baked()).toBe('')
    expect(revoke).toHaveBeenCalledWith('blob:one')
  })

  it('keeps the live blur and reports when baking fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dispose = installWallpaperBake(root, '/scene.jpg', {
      bake: () => Promise.reject(new Error('no canvas')),
      revoke: vi.fn(),
    })
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(flagged()).toBe(false)
    dispose()
    warn.mockRestore()
  })
})
