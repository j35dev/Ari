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

  it('keeps the chat on the same plate as the sidebar', () => {
    // A fill on the session canvas tinted the chat away from the rest of the
    // window: near-black on dark themes, near-white on light ones.
    const canvasRule = /:is\(\.ari-welcome-glow, \.ari-session-canvas\) \{([^}]+)\}/.exec(css)?.[1]
    expect(canvasRule).toContain('background: none')
    expect(canvasRule).toContain('isolation: isolate')
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toContain('var(--ari-bg)')
    expect(declarations).not.toContain('--ari-haze-presence')
  })

  it('shows sharp art only on empty screens, fading into the plate', () => {
    const art = /\.ari-session-scene,\s*\[data-ari-wallpaper\] \.ari-welcome-glow::before \{([^}]+)\}/.exec(
      css,
    )?.[1]
    // Window-pinned so it lines up with the baked blur it fades into.
    expect(art).toContain('fixed')
    expect(art).toContain('mask-image: var(--ari-haze-fade)')
    expect(css).toMatch(/--ari-haze-fade: linear-gradient\([^;]*transparent 88%\)/)
    expect(css).not.toMatch(/\.ari-composer[\w-]*/)
  })

  it('feathers the reading lane on every edge', () => {
    const lane = /\.ari-reading-lane::before \{([^}]+)\}/.exec(css)?.[1]
    expect(lane).toContain('--ari-surface-0')
    expect(lane).toMatch(/background: linear-gradient\(\s*to bottom,\s*transparent,/)
    expect(lane).toMatch(/mask-image: linear-gradient\(\s*to right,\s*transparent,/)
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
    expect(media).toContain('--ari-haze-art')
    expect(media).toMatch(/\.ari-reading-lane::before \{\s*content: none;/)
  })

  it('derives every color from theme tokens (no raw literals outside tokens.css)', () => {
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(declarations).not.toMatch(/\boklch\(/)
    expect(declarations).not.toMatch(/\brgba?\(/)
  })
})
