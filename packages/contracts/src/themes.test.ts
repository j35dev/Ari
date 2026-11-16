import { describe, expect, it } from 'vitest'
import {
  customThemeSchema,
  customThemeLibrarySchema,
  neonThemeExample,
  themeAuthoringPrompt,
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
    expect(customThemeSchema.safeParse({ ...neonThemeExample, css: 'body{}' }).success).toBe(false)
    expect(customThemeSchema.safeParse({ ...neonThemeExample, version: 2 }).success).toBe(false)
    expect(
      customThemeSchema.safeParse({ ...neonThemeExample, density: 'hide-controls' }).success,
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
