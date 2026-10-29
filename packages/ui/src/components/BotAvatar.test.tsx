import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BOT_PALETTE_NAMES, BOT_SHAPES } from '../bot-character'
import { BotAvatar, type BotMood } from './BotAvatar'

const MOODS: BotMood[] = ['idle', 'working', 'replying', 'needs-you', 'asleep', 'error']

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg')
  if (svg === null) throw new Error('no svg')
  return svg
}

describe('BotAvatar', () => {
  it.each(BOT_SHAPES.flatMap((shape) => MOODS.map((mood) => [shape, mood] as const)))(
    'draws a %s in the %s mood in every palette',
    (shape, mood) => {
      for (let palette = 0; palette < BOT_PALETTE_NAMES.length; palette += 1) {
        const { container, unmount } = render(
          <BotAvatar character={{ shape, palette }} mood={mood} size={96} />,
        )
        const svg = svgOf(container)
        expect(svg).toHaveClass('ari-bot', `ari-bot--${mood}`)
        expect(svg.dataset.mood).toBe(mood)
        expect(svg.querySelector('.ari-bot-eyes')).not.toBeNull()
        // Every colour comes from the palette tokens, never a literal.
        expect(container.innerHTML).toContain(`var(--ari-bot-${palette}-base)`)
        expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|oklch\(/i)
        unmount()
      }
    },
  )

  it('keeps its filter ids unique per instance and free of colons', () => {
    const { container } = render(
      <>
        <BotAvatar character={{ shape: 'drop', palette: 0 }} size={64} />
        <BotAvatar character={{ shape: 'drop', palette: 0 }} size={64} />
      </>,
    )
    const ids = [...container.querySelectorAll('[id]')].map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/)
    // References resolve to this instance's own definitions.
    for (const node of container.querySelectorAll('[filter]')) {
      const ref = /url\(#(.+)\)/.exec(node.getAttribute('filter') ?? '')?.[1]
      expect(ref !== undefined && ids.includes(ref)).toBe(true)
    }
  })

  it('drops the filters and effects below 30 px and thickens the line', () => {
    const { container: small } = render(
      <BotAvatar character={{ shape: 'pill', palette: 2 }} mood="working" size={20} />,
    )
    expect(small.querySelector('filter')).toBeNull()
    expect(small.querySelector('[filter]')).toBeNull()
    expect(small.querySelector('.ari-bot-trail')).toBeNull()
    expect(small.querySelector('[stroke-width="6.4"]')).not.toBeNull()
    const tinyEye = small.querySelector('.ari-bot-eye')
    expect(Number(tinyEye?.getAttribute('width'))).toBeCloseTo(8.5)

    const { container: large } = render(
      <BotAvatar character={{ shape: 'pill', palette: 2 }} mood="working" size={96} />,
    )
    expect(large.querySelector('.ari-bot-trail')).not.toBeNull()
    expect(large.querySelector('feTurbulence')).not.toBeNull()
    expect(Number(large.querySelector('.ari-bot-eye')?.getAttribute('width'))).toBeCloseTo(7.2)
  })

  it('keeps the grain and effects off at roster size', () => {
    const { container } = render(
      <BotAvatar character={{ shape: 'drop', palette: 6 }} mood="replying" size={36} />,
    )
    expect(container.querySelector('feTurbulence')).toBeNull()
    expect(container.querySelector('.ari-bot-spark')).toBeNull()
    expect(container.querySelector('feGaussianBlur')).not.toBeNull()
  })

  it('opens its eyes wider when it needs you', () => {
    const { container } = render(
      <BotAvatar character={{ shape: 'drop', palette: 0 }} mood="needs-you" size={40} />,
    )
    expect(Number(container.querySelector('.ari-bot-eye')?.getAttribute('width'))).toBeCloseTo(
      7.2 * 1.15,
    )
  })

  it('smiles at rest when it is a cloud', () => {
    const { container } = render(<BotAvatar character={{ shape: 'cloud', palette: 1 }} />)
    expect(container.querySelector('.ari-bot-eye')).toBeNull()
    expect(container.querySelectorAll('.ari-bot-eyes path')).toHaveLength(2)
  })

  it('gives pale palettes dark eyes without the glow', () => {
    const { container } = render(<BotAvatar character={{ shape: 'drop', palette: 4 }} size={64} />)
    expect(container.querySelector('linearGradient')).toBeNull()
    expect(container.querySelector('.ari-bot-eyes')?.getAttribute('style')).toContain(
      'var(--ari-bot-4-eye)',
    )
  })

  it('is decoration without a label and an image with one', () => {
    const { container, rerender } = render(<BotAvatar character={{ shape: 'drop', palette: 0 }} />)
    expect(svgOf(container)).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('img')).toBeNull()

    rerender(<BotAvatar character={{ shape: 'drop', palette: 0 }} label="Forge" />)
    expect(screen.getByRole('img', { name: 'Forge' })).not.toHaveAttribute('aria-hidden')
  })

  it('renders at the size asked, 32 px by default', () => {
    const { container, rerender } = render(<BotAvatar character={{ shape: 'drop', palette: 0 }} />)
    expect(svgOf(container)).toHaveAttribute('width', '32')
    rerender(<BotAvatar character={{ shape: 'drop', palette: 0 }} size={96} className="ring" />)
    expect(svgOf(container)).toHaveAttribute('height', '96')
    expect(svgOf(container)).toHaveClass('ring')
  })

  it('starts each avatar at its own point in the cycle', () => {
    const { container } = render(
      <>
        <BotAvatar character={{ shape: 'drop', palette: 0 }} />
        <BotAvatar character={{ shape: 'drop', palette: 0 }} />
        <BotAvatar character={{ shape: 'drop', palette: 0 }} />
      </>,
    )
    const phases = [...container.querySelectorAll('svg')].map((svg) =>
      svg.style.getPropertyValue('--ari-bot-phase'),
    )
    for (const phase of phases) expect(phase).toMatch(/^-\d+\.\d{2}s$/)
    expect(new Set(phases).size).toBeGreaterThan(1)
  })
})
