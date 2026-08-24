import { describe, expect, it } from 'vitest'
import { themes } from '@ari/ui/themes'
import { themeWindowChrome } from './window'

describe('themeWindowChrome', () => {
  it('requests platform translucency for glass themes', () => {
    expect(themeWindowChrome(themes.obsidian, 'win32')).toMatchObject({
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic',
    })
    expect(themeWindowChrome(themes.obsidian, 'darwin')).toMatchObject({
      vibrancy: 'under-window',
      visualEffectState: 'active',
    })
    expect(themeWindowChrome(themes.obsidian, 'linux')).toMatchObject({ transparent: true })
  })

  it('gives opaque themes a solid background and no translucency', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const chrome = themeWindowChrome(themes.graphite, platform)
      expect(chrome.backgroundMaterial).toBeUndefined()
      expect(chrome.vibrancy).toBeUndefined()
      expect(chrome.transparent).toBeUndefined()
      expect(chrome.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('never flashes black for light themes', () => {
    const chrome = themeWindowChrome(themes.porcelain, 'win32')
    const red = parseInt(chrome.backgroundColor.slice(1, 3), 16)
    expect(red).toBeGreaterThan(0xd0)
    // Overlay symbols must be dark on a light backdrop.
    expect(parseInt(chrome.symbolColor.slice(1, 3), 16)).toBeLessThan(0x80)
  })

  it('derives the overlay symbol color from the theme foreground', () => {
    expect(themeWindowChrome(themes.obsidian, 'win32').symbolColor).toMatch(/^#[0-9a-f]{6}$/)
    expect(themeWindowChrome(themes.obsidian, 'win32').symbolColor).not.toBe(
      themeWindowChrome(themes.porcelain, 'win32').symbolColor,
    )
  })

  it('differs between a glass theme and an opaque theme', () => {
    const glass = themeWindowChrome(themes.nocturne, 'win32')
    const opaque = themeWindowChrome(themes.verdant, 'win32')
    expect(glass.backgroundColor).not.toBe(opaque.backgroundColor)
    expect(glass.backgroundMaterial).toBe('acrylic')
    expect(opaque.backgroundMaterial).toBeUndefined()
  })
})
