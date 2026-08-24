import { describe, expect, it } from 'vitest'
import { contrastRatio, oklchToHex, parseOklch, relativeLuminance } from './color'
import { themes } from './themes'

describe('parseOklch', () => {
  it('reads lightness, chroma, hue and optional alpha', () => {
    expect(parseOklch('oklch(0.673 0.182 276.94)')).toEqual({
      l: 0.673,
      c: 0.182,
      h: 276.94,
      alpha: 1,
    })
    expect(parseOklch('oklch(1 0 0 / 8%)')?.alpha).toBeCloseTo(0.08, 5)
    expect(parseOklch('oklch(0.5 0.1 200 / 0.4)')?.alpha).toBeCloseTo(0.4, 5)
  })

  it('rejects non-oklch input', () => {
    expect(parseOklch('#ffffff')).toBeNull()
    expect(parseOklch('rgb(0 0 0)')).toBeNull()
    expect(() => contrastRatio('#fff', 'oklch(0.09 0 0)')).toThrow(/unparseable/)
  })
})

describe('relativeLuminance', () => {
  it('anchors at pure black and pure white', () => {
    expect(relativeLuminance({ l: 0, c: 0, h: 0, alpha: 1 })).toBeCloseTo(0, 4)
    expect(relativeLuminance({ l: 1, c: 0, h: 0, alpha: 1 })).toBeCloseTo(1, 2)
  })

  it('yields 21:1 for black on white', () => {
    expect(contrastRatio('oklch(1 0 0)', 'oklch(0 0 0)')).toBeCloseTo(21, 1)
  })
})

describe('oklchToHex', () => {
  it('converts achromatic and chromatic literals to sRGB hex', () => {
    expect(oklchToHex('oklch(1 0 0)')).toBe('#ffffff')
    expect(oklchToHex('oklch(0 0 0)')).toBe('#000000')
    expect(oklchToHex('oklch(0.09 0 0)')).toMatch(/^#0[0-9a-f]{5}$/)
    expect(oklchToHex('nope')).toBeNull()
  })

  it('drops alpha so window backdrops stay opaque', () => {
    expect(oklchToHex('oklch(0.5 0 0 / 20%)')).toBe(oklchToHex('oklch(0.5 0 0)'))
  })

  it('gives light themes a bright backdrop and dark themes a dark one', () => {
    const light = oklchToHex(themes.porcelain.colors.bg)
    const dark = oklchToHex(themes.obsidian.colors.bg)
    expect(light).not.toBeNull()
    expect(dark).not.toBeNull()
    const value = (hex: string): number => parseInt(hex.slice(1, 3), 16)
    expect(value(light as string)).toBeGreaterThan(0xd0)
    expect(value(dark as string)).toBeLessThan(0x30)
  })
})

describe('measured palette contrast', () => {
  // Regression guard on the exact ratios shipped with the six palettes.
  const expected: Record<string, [number, number, number]> = {
    obsidian: [16.44, 7.98, 6.31],
    graphite: [16.85, 8.28, 8.67],
    nocturne: [17.16, 9.23, 9.74],
    verdant: [16.73, 9.03, 10.78],
    porcelain: [15.79, 6.42, 5.52],
    sandstone: [14.73, 6.13, 4.47],
  }

  it.each(Object.entries(expected))('%s holds its measured ratios', (id, [fg, muted, accent]) => {
    const theme = themes[id as keyof typeof themes]
    expect(contrastRatio(theme.colors.fg, theme.colors.bg)).toBeCloseTo(fg, 1)
    expect(contrastRatio(theme.colors['fg-muted'], theme.colors.bg)).toBeCloseTo(muted, 1)
    expect(contrastRatio(theme.colors.accent, theme.colors['surface-1'])).toBeCloseTo(accent, 1)
  })
})
