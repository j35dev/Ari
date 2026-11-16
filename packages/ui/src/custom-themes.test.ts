import { afterEach, expect, it } from 'vitest'
import { neonThemeExample, themeParts } from '@ari/contracts/themes'
import {
  customThemeCss,
  paintCustomTheme,
  resolveCustomTheme,
  resolveThemeCss,
  stripThemeCssFetches,
  themeCssValueFetches,
  themePartSelectors,
} from './custom-themes'

afterEach(() => paintCustomTheme(undefined))
it('covers every advertised slot with a selector owned by Ari', () => {
  expect(Object.keys(themePartSelectors).sort()).toEqual([...themeParts].sort())
})
it('rejects an unreadable inherited palette before changing the live DOM', () => {
  paintCustomTheme(neonThemeExample)
  const before = document.getElementById('ari-custom-theme-style')!.textContent
  expect(() =>
    paintCustomTheme({
      ...neonThemeExample,
      colors: {
        ...neonThemeExample.colors,
        'surface-1': '#edfaff',
      },
    }),
  ).toThrow(/contrast/)
  expect(document.getElementById('ari-custom-theme-style')!.textContent).toBe(before)
})
it('scopes overrides, preserves recovery controls and removes the entire skin on reset', () => {
  const css = customThemeCss(neonThemeExample)
  expect(css).toContain('html[data-ari-custom-theme="custom:neon"]')
  expect(customThemeCss({ ...neonThemeExample, density: 'compact' })).toContain('--spacing:3.5px')
  expect(css).toContain(':not([data-ari-theme-recovery],[data-ari-theme-recovery] *)')
  expect(css).toContain('outline:2px solid var(--ari-fg)')
  expect(css).not.toMatch(/url\(|@import|pointer-events|display:none|position:/)
  expect(resolveCustomTheme(neonThemeExample).colors.accent).toBe('#54f2e4')
  paintCustomTheme(neonThemeExample)
  expect(document.documentElement.dataset['ariCustomTheme']).toBe('custom:neon')
  paintCustomTheme(undefined)
  expect(document.getElementById('ari-custom-theme-style')).toBeNull()
  expect(document.documentElement.dataset['ariCustomTheme']).toBeUndefined()
})

it('points asset references at stored files and filters anything that would load remotely', () => {
  const sha = 'a'.repeat(64)
  const theme = {
    ...neonThemeExample,
    assets: [{ name: 'hat.png', sha256: sha }],
    css: '[data-ari-part="brand"]::after{content:"👒";background:url("asset:hat.png")}',
  }
  expect(resolveThemeCss(theme)).toContain(`url("ari-theme-asset://a/${sha}.png")`)
  expect(resolveThemeCss({ ...theme, css: 'body{background:url(https://example.com)}' })).toBe('')
  expect(themeCssValueFetches(`url("ari-theme-asset://a/${sha}.png")`)).toBe(false)
  expect(themeCssValueFetches('url("data:image/svg+xml;utf8,<svg></svg>")')).toBe(false)
  expect(themeCssValueFetches('url("https://example.com/x.png")')).toBe(true)
  expect(themeCssValueFetches('url("ari-theme-asset://a/../secret")')).toBe(true)
})

it('draws themes saved before the boxless rule without boxing broad parts', () => {
  const css = customThemeCss({
    ...neonThemeExample,
    parts: {
      button: {
        default: { color: '#edfaff', borderWidth: 1, backgroundColor: '#1b1f2e' },
        hover: { backgroundColor: '#24334e' },
      },
    },
  })
  const rules = css.split('\n').filter((rule) => rule.includes('button, [role="button"]'))
  expect(rules[0]).toContain('color:#edfaff')
  expect(rules[0]).not.toMatch(/border-width|background-color/)
  expect(rules[1]).toContain('background-color:#24334e')
})

// Review of #543: Chromium stores a shorthand holding var() as longhands that read back
// empty, so a per-property check kept this remote url(). jsdom keeps the shorthand, so
// the rule below is shaped the way Chromium hands it over.
it('drops a whole rule whose var() shorthand would load remotely', () => {
  const leak = 'background: var(--z) url(https://evil.example/leak)'
  const style = document.createElement('div').style
  style.cssText = leak
  const longhands = ['background-image', 'background-position-x', 'background-color']
  Object.defineProperties(style, {
    length: { value: longhands.length },
    item: { value: (index: number) => longhands[index] ?? '' },
    getPropertyValue: { value: () => '' },
  })
  expect(style.cssText).toContain('url(https://evil.example/leak)')
  const kept = document.createElement('div').style
  kept.cssText = 'content: "/*"'
  const rules = [{ style: kept }, { style }, { style: kept }] as unknown as CSSRule[]
  stripThemeCssFetches({
    get cssRules() {
      return rules as unknown as CSSRuleList
    },
    deleteRule: (index: number) => void rules.splice(index, 1),
  })
  expect(rules).toHaveLength(2)
  expect(rules.every((rule) => (rule as CSSStyleRule).style === kept)).toBe(true)
})
