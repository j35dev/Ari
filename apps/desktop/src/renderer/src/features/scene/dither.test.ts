import { describe, expect, it } from 'vitest'
import { ditherThreshold, sceneCoverage, sceneSink } from './dither'
import { sceneArt } from './DitherScene'

describe('scene dissolve', () => {
  it('keeps the art whole at the top and removes it by the bottom', () => {
    for (const lum of [0, 0.5, 1]) {
      expect(sceneCoverage(0, lum)).toBe(1)
      expect(sceneCoverage(0.95, lum)).toBe(0)
    }
  })

  it('lets bright parts of the picture survive longer than dark ones', () => {
    expect(sceneCoverage(0.5, 0.9)).toBeGreaterThan(sceneCoverage(0.5, 0.1))
  })

  it('never thins out at the same height as the picture gets brighter', () => {
    for (let v = 0; v <= 1; v += 0.05) {
      expect(sceneCoverage(v, 0.8)).toBeGreaterThanOrEqual(sceneCoverage(v, 0.2))
    }
  })

  it('sinks the art into the page progressively, and never completely', () => {
    expect(sceneSink(0)).toBe(0)
    expect(sceneSink(0.4)).toBeGreaterThan(0)
    expect(sceneSink(1)).toBeLessThan(1)
  })

  it('spreads thresholds evenly across an 8x8 tile and repeats', () => {
    const seen = new Set<number>()
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(ditherThreshold(x, y))
    expect(seen.size).toBe(64)
    expect(Math.min(...seen)).toBeGreaterThan(0)
    expect(Math.max(...seen)).toBeLessThan(1)
    expect(ditherThreshold(9, 10)).toBe(ditherThreshold(1, 2))
  })
})

describe('scene art', () => {
  it('uses the chosen wallpaper for every view', () => {
    expect(sceneArt('session', 'stillwater', 'dark')).toBe('stillwater')
    expect(sceneArt('aria', 'stillwater', 'light')).toBe('stillwater')
  })

  it('gives Aria her own art when no wallpaper is chosen', () => {
    expect(sceneArt('aria', 'none', 'dark')).not.toBe(sceneArt('session', 'none', 'dark'))
    expect(sceneArt('aria', 'none', 'light')).not.toBe(sceneArt('session', 'none', 'light'))
  })
})
