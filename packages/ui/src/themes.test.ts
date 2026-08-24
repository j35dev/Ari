import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './color'
import { defaultThemeId, isThemeId, systemTheme, themeColorRoles, themeIds, themeList, themeOf } from './themes'

const tokensCss = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8')

/** Extracts the declarations of one `[data-ari-theme='<id>']` block. */
function themeBlock(id: string): Map<string, string> {
  const start = tokensCss.indexOf(`[data-ari-theme='${id}']`)
  expect(start, `tokens.css has no block for ${id}`).toBeGreaterThan(-1)
  const open = tokensCss.indexOf('{', start)
  const close = tokensCss.indexOf('}', open)
  const declarations = new Map<string, string>()
  for (const line of tokensCss.slice(open + 1, close).split('\n')) {
    const match = /^\s*--ari-([a-z0-9-]+):\s*(.+);\s*$/.exec(line)
    if (match?.[1] && match[2]) declarations.set(match[1], match[2])
  }
  return declarations
}

describe('theme registry', () => {
  it('exposes six themes across both schemes', () => {
    expect(themeIds).toHaveLength(6)
    expect(themeList.filter((t) => t.scheme === 'dark').length).toBeGreaterThanOrEqual(2)
    expect(themeList.filter((t) => t.scheme === 'light')).toHaveLength(2)
    expect(themeList.some((t) => t.glass)).toBe(true)
    expect(themeList.some((t) => !t.glass)).toBe(true)
  })

  it.each(themeList)('$id defines every color role exactly once', (theme) => {
    for (const role of themeColorRoles) {
      const value = theme.colors[role]
      expect(value, `${theme.id} missing ${role}`).toBeTruthy()
    }
    expect(Object.keys(theme.colors).sort()).toEqual([...themeColorRoles].sort())
  })

  it.each(themeList)('$id uses distinct palettes, not one hue rotated', (theme) => {
    const others = themeList.filter((t) => t.id !== theme.id)
    for (const other of others) {
      const identical = themeColorRoles.every((role) => other.colors[role] === theme.colors[role])
      expect(identical, `${theme.id} duplicates ${other.id}`).toBe(false)
    }
  })

  it('resolves stored values and system preference', () => {
    expect(themeOf('nocturne').id).toBe('nocturne')
    expect(themeOf('comet-glass').id).toBe(defaultThemeId)
    expect(themeOf(undefined).id).toBe(defaultThemeId)
    expect(isThemeId('verdant')).toBe(true)
    expect(isThemeId('nope')).toBe(false)
    expect(systemTheme(true).scheme).toBe('dark')
    expect(systemTheme(false).scheme).toBe('light')
  })
})

describe('tokens.css mirrors the registry', () => {
  it.each(themeList)('$id block matches every registry value', (theme) => {
    const block = themeBlock(theme.id)
    for (const role of themeColorRoles) {
      expect(block.get(role), `${theme.id} --ari-${role}`).toBe(theme.colors[role])
    }
    expect(tokensCss).toContain(`color-scheme: ${theme.scheme};`)
  })

  it('keeps non-color tokens in :root only', () => {
    const rootStart = tokensCss.indexOf(':root {')
    const rootEnd = tokensCss.indexOf('}', rootStart)
    const root = tokensCss.slice(rootStart, rootEnd)
    for (const token of ['--ari-radius-md', '--ari-font-ui', '--ari-dur-base', '--ari-sidebar-width']) {
      expect(root).toContain(token)
    }
    // Colors never live in the bare :root block.
    expect(root).not.toContain('--ari-accent:')
  })
})

describe('WCAG contrast floors', () => {
  it.each(themeList)('$id text and accent clear the floors', (theme) => {
    const c = theme.colors
    expect(contrastRatio(c.fg, c.bg)).toBeGreaterThanOrEqual(7)
    expect(contrastRatio(c['fg-muted'], c.bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(c.accent, c['surface-1'])).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(c['fg-on-accent'], c.accent)).toBeGreaterThanOrEqual(2.9)
  })

  it.each(themeList)('$id semantic colors stay legible on surface-1', (theme) => {
    for (const role of ['success', 'warning', 'danger', 'info', 'busy'] as const) {
      expect(
        contrastRatio(theme.colors[role], theme.colors['surface-1']),
        `${theme.id} ${role}`,
      ).toBeGreaterThanOrEqual(3)
    }
  })
})
