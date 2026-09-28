import { describe, expect, it } from 'vitest'
import { themeIdSchema, wallpaperIdSchema } from '@ari/contracts/settings'
import { themeIds, themes } from '@ari/ui/themes'
import { wallpaperIds } from '@ari/ui/wallpapers'
import { themeWindowChrome } from './window'

// The two lists are hand-maintained in packages that must not import each
// other (@ari/contracts stays UI-free), so nothing but this cross-package
// assertion stops a seventh theme from being unpersistable.
describe('theme registries agree across packages', () => {
  it('contracts accepts exactly the themes the UI defines', () => {
    expect([...themeIdSchema.options].sort()).toEqual([...themeIds].sort())
  })

  it('contracts accepts exactly the wallpapers the UI defines', () => {
    expect([...wallpaperIdSchema.options].sort()).toEqual([...wallpaperIds].sort())
  })
})

describe('themeWindowChrome', () => {
  it('gives every theme a solid background', () => {
    for (const theme of Object.values(themes)) {
      const chrome = themeWindowChrome(theme)
      expect(chrome.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('never flashes black for light themes', () => {
    const chrome = themeWindowChrome(themes.porcelain)
    const red = parseInt(chrome.backgroundColor.slice(1, 3), 16)
    expect(red).toBeGreaterThan(0xd0)
    // Overlay symbols must be dark on a light backdrop.
    expect(parseInt(chrome.symbolColor.slice(1, 3), 16)).toBeLessThan(0x80)
  })

  it('derives the overlay symbol color from the theme foreground', () => {
    expect(themeWindowChrome(themes.obsidian).symbolColor).toMatch(/^#[0-9a-f]{6}$/)
    expect(themeWindowChrome(themes.obsidian).symbolColor).not.toBe(
      themeWindowChrome(themes.porcelain).symbolColor,
    )
  })

  it('uses each theme background rather than a shared transparent value', () => {
    expect(themeWindowChrome(themes.nocturne).backgroundColor).not.toBe(
      themeWindowChrome(themes.verdant).backgroundColor,
    )
  })
})
