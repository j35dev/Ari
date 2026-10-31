import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WALLPAPER_BLUR_PX, WALLPAPER_SATURATE } from './wallpaper-bake'

/**
 * wallpaper.css is the whole feature — jsdom cannot evaluate `backdrop-filter`
 * or `color-mix`, so these assertions guard its structure instead: one chrome
 * plate, image-only Haze layers, provider-resolved asset URLs, and no raw colors.
 */
const css = readFileSync(resolve(process.cwd(), 'src/wallpaper.css'), 'utf8')

describe('wallpaper.css', () => {
  it('paints one continuous wallpaper pane', () => {
    expect(css).toContain('[data-ari-wallpaper] .ari-wallpaper-pane {')
    expect(css).toMatch(/\.ari-wallpaper-pane \{[^}]*background: var\(--ari-wallpaper-pane\)/)
  })

  it('paints the baked blur once one lands, and blurs live only until then', () => {
    expect(css).toMatch(
      /\[data-ari-wallpaper\]\[data-ari-wallpaper-baked\] body::before \{[^}]*background-image: var\(--ari-wallpaper-baked\)/,
    )
    // The live filter is scoped to the pending state, never the baked one.
    const live = /([^{}]+)\{[^}]*backdrop-filter: blur\(28px\) saturate\(1\.35\)/.exec(css)
    expect(live?.[1]).toContain(':not([data-ari-wallpaper-baked])')
    expect(css.match(/^\s*backdrop-filter: blur/gm)).toHaveLength(1)
    // The fallback must be the filter the bake reproduces.
    expect(css).toContain(`blur(${WALLPAPER_BLUR_PX}px) saturate(${WALLPAPER_SATURATE})`)
  })

  it('neutralizes nested chrome and pane fills so no surface double-tints', () => {
    expect(css).toContain('[data-ari-wallpaper] .ari-wallpaper-pane .bg-surface-0,')
    expect(css).toContain('[data-ari-wallpaper] .ari-wallpaper-pane .bg-bg {')
    expect(css).toMatch(/\.bg-bg \{[^}]*background-color: transparent/)
  })

  it('takes the scene URL from the provider, never a relative asset path', () => {
    expect(css).toMatch(/body::before \{[^}]*background-image: var\(--ari-wallpaper-image\)/)
    // A `url('./assets/...')` literal here survives the production build
    // unrebased and unhashed — it only ever resolved in dev. This is the
    // regression guard for that: the bundle must not carry asset paths from
    // this file at all.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/url\(\s*['"]?\.\//)
  })

  it('uses full-presence Haze only on the welcome and empty-session backgrounds', () => {
    const canvasRule = /:is\(\.ari-welcome-glow, \.ari-session-canvas\) \{([^}]+)\}/.exec(css)?.[1]
    expect(canvasRule).toContain('--ari-haze-presence: 1')
    expect(canvasRule).toContain('--ari-wallpaper-image')
    expect(canvasRule).toContain('var(--ari-bg) 92%')
    expect(canvasRule).toContain('isolation: isolate')
    expect(canvasRule).not.toContain('filter:')
    expect(canvasRule).not.toContain('opacity:')
    expect(css).toMatch(/\.ari-session-canvas \{\s*--ari-haze-presence: 0\.2/)
    expect(css).toMatch(
      /\.ari-session-canvas:has\(> \.ari-session-scene\[data-visible\]\) \{\s*--ari-haze-presence: 1/,
    )
  })

  it('blurs aligned decorative image copies instead of the live UI', () => {
    expect(css).toMatch(/::before \{\s*filter: blur\(8px\);\s*mask-image:/)
    expect(css).toMatch(/::after \{\s*filter: blur\(20px\);\s*mask-image:/)
    const layers = /::after \{\s*content: '';([^}]+)\}/.exec(css)?.[1]
    expect(layers).toContain('pointer-events: none')
    expect(layers).toContain('z-index: -1')
    expect(layers).toContain('background: inherit')
    expect(layers).toContain('clip-path: inset(0)')
    expect(css).toMatch(/\.ari-session-scene \{\s*background-image: none;/)
    expect(css).not.toMatch(/\.ari-composer[\w-]*/)
  })

  it('keeps one fixed wallpaper look without adding settings variants', () => {
    expect(css).not.toContain('data-ari-wallpaper-look')
    expect(css).not.toContain('--wallpaper-scrim-')
  })

  it('drops blur under reduced transparency instead of hiding the scene', () => {
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)')
    const media = css.slice(css.indexOf('@media (prefers-reduced-transparency: reduce)'))
    expect(media).toContain('backdrop-filter: none')
    expect(media).toContain('--ari-wallpaper-pane')
    expect(media).toContain('var(--ari-bg) 92%')
    expect(media).toContain('content: none;\n    filter: none;')
  })

  it('derives every color from theme tokens (no raw literals outside tokens.css)', () => {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\boklch\(/)
    expect(declarations).not.toMatch(/\brgba?\(/)
  })
})
