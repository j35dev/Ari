import { describe, expect, it } from 'vitest'
import {
  IRIS_COLOR_SLOTS,
  IRIS_HUE_BASE,
  IRIS_HUE_STEP,
  irisHue,
  irisLetter,
  irisPattern,
} from './iris-tile'

describe('irisPattern', () => {
  it('is deterministic for a given seed', () => {
    expect(irisPattern('proj-1')).toEqual(irisPattern('proj-1'))
  })

  it('yields distinct constellations for nearby ids', () => {
    expect(irisPattern('proj-1')).not.toEqual(irisPattern('proj-2'))
  })

  it('lights 3–5 cells so idle never matches the running ring', () => {
    const samples = ['ari', 'desktop', 'engine', 'providers', 'docs', 'proj-1', 'a']
    for (const seed of samples) {
      const lit = irisPattern(seed).filter(Boolean).length
      expect(lit).toBeGreaterThanOrEqual(3)
      expect(lit).toBeLessThanOrEqual(5)
    }
  })

  it('returns a dark tile for an empty seed', () => {
    expect(irisPattern('').every((cell) => !cell)).toBe(true)
  })

  it('does not restyle when only the display name would change', () => {
    const fromId = irisPattern('p_abc')
    expect(irisPattern('p_abc')).toEqual(fromId)
  })
})

describe('irisHue', () => {
  it('walks 40° steps from indigo 277 across eight slots', () => {
    expect(irisHue(0)).toBe(IRIS_HUE_BASE)
    expect(irisHue(1)).toBe(IRIS_HUE_BASE + IRIS_HUE_STEP)
    expect(irisHue(7)).toBe(IRIS_HUE_BASE + 7 * IRIS_HUE_STEP)
  })

  it('wraps out-of-range and negative indices', () => {
    expect(irisHue(IRIS_COLOR_SLOTS)).toBe(irisHue(0))
    expect(irisHue(-1)).toBe(irisHue(7))
  })
})

describe('irisLetter', () => {
  it('takes the first trimmed character, uppercased', () => {
    expect(irisLetter('ari')).toBe('A')
    expect(irisLetter('  docs')).toBe('D')
  })

  it('falls back to a mark when the name is empty', () => {
    expect(irisLetter('')).toBe('?')
    expect(irisLetter('   ')).toBe('?')
  })
})
