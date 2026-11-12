import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EffortGlyph, effortLevels } from './effort-level'

const named = (...ids: string[]) => ids.map((id) => ({ id, label: id }))
const filled = (levels: { filled: number }[]) => levels.map((level) => level.filled)

describe('effortLevels', () => {
  it('rises one bar per level for the usual low, medium, high', () => {
    const levels = effortLevels(named('low', 'medium', 'high'))
    expect(filled(levels)).toEqual([1, 2, 3])
    expect(levels.every((level) => level.bars === 3)).toBe(true)
  })

  it('reads familiar names, so a list sent highest-first still draws the right way up', () => {
    expect(filled(effortLevels(named('high', 'medium', 'low')))).toEqual([3, 2, 1])
  })

  it('recognises a level by its label when the id is opaque', () => {
    const levels = effortLevels([
      { id: 'opt-a', label: 'X-High' },
      { id: 'opt-b', label: 'Low' },
    ])
    expect(filled(levels)).toEqual([2, 1])
  })

  it("takes an agent's own vocabulary in the order it was given", () => {
    expect(filled(effortLevels(named('think', 'think-hard', 'ultrathink')))).toEqual([1, 2, 3])
  })

  it('spreads long lists over five bars, lowest at one and highest at five', () => {
    const levels = effortLevels(named('a', 'b', 'c', 'd', 'e', 'f', 'g'))
    expect(levels[0]).toEqual({ filled: 1, bars: 5 })
    expect(levels.at(-1)).toEqual({ filled: 5, bars: 5 })
    const counts = filled(levels)
    expect([...counts].sort((a, b) => a - b)).toEqual(counts)
  })

  it('fills the glyph for a single level and returns nothing for none', () => {
    expect(effortLevels(named('high'))).toEqual([{ filled: 2, bars: 2 }])
    expect(effortLevels([])).toEqual([])
  })
})

describe('EffortGlyph', () => {
  it('draws one bar per step and fades the ones beyond the level', () => {
    const { container } = render(<EffortGlyph filled={2} bars={4} />)
    const bars = Array.from(container.querySelectorAll('rect'))
    expect(bars).toHaveLength(4)
    expect(bars.map((bar) => bar.getAttribute('opacity'))).toEqual(['1', '1', '0.22', '0.22'])
    // Each bar is taller than the one before it.
    const heights = bars.map((bar) => Number(bar.getAttribute('height')))
    expect([...heights].sort((a, b) => a - b)).toEqual(heights)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
