import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wallpapers } from './wallpapers'

/**
 * wallpaper.css is the whole feature — jsdom cannot evaluate `backdrop-filter`
 * or `color-mix`, so these assertions guard its structure instead: one plate,
 * nothing nested re-tinting it, every scene wired, and no raw colors.
 */
const css = readFileSync(resolve(process.cwd(), 'src/wallpaper.css'), 'utf8')

describe('wallpaper.css', () => {
  it('paints one continuous plate carrying the glass recipe', () => {
    expect(css).toContain('[data-ari-wallpaper] .ari-glass-pane {')
    expect(css).toMatch(/\.ari-glass-pane \{[^}]*background: var\(--ari-glass-scrim\)/)
    expect(css).toMatch(/\.ari-glass-pane \{[^}]*backdrop-filter: blur\(28px\) saturate\(1\.35\)/)
  })

  it('neutralizes nested chrome and pane fills so no surface double-tints', () => {
    expect(css).toContain('[data-ari-wallpaper] .ari-glass-pane .ari-glass,')
    expect(css).toContain('[data-ari-wallpaper] .ari-glass-pane .bg-bg {')
    expect(css).toMatch(/\.bg-bg \{[^}]*background-color: transparent/)
  })

  it('wires every bundled scene to its asset', () => {
    for (const wallpaper of wallpapers) {
      expect(css).toContain(`[data-ari-wallpaper='${wallpaper.id}'] body::before`)
      expect(css).toContain(`url('./assets/wallpapers/${wallpaper.id}.jpg')`)
    }
  })

  it('has no visibility-look variants left (one uniform look)', () => {
    expect(css).not.toContain('data-ari-wallpaper-look')
    expect(css).not.toContain('--wallpaper-scrim-')
  })

  it('drops blur under reduced transparency instead of hiding the scene', () => {
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)')
    const media = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce)'))
    expect(media).toContain('backdrop-filter: none')
    expect(media).toContain('--ari-glass-scrim')
  })

  it('derives every color from theme tokens (no raw literals outside tokens.css)', () => {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\boklch\(/)
    expect(declarations).not.toMatch(/\brgba?\(/)
  })
})
