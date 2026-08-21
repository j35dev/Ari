import { describe, expect, it } from 'vitest'
import {
  matchCommands,
  score,
  SCORE_EXACT_PREFIX,
} from './match'

describe('score', () => {
  it('returns 0 for an empty or whitespace query', () => {
    expect(score('', 'Settings')).toBe(0)
    expect(score('   ', 'Settings')).toBe(0)
  })

  it('returns 0 when the query is not a subsequence of the label', () => {
    expect(score('zzz', 'Settings')).toBe(0)
    expect(score('stt', 'Terminal')).toBe(0)
  })

  it('ranks exact prefix above substring above subsequence', () => {
    expect(score('set', 'Settings')).toBeGreaterThan(score('set', 'Reset settings'))
    expect(score('set', 'Reset settings')).toBeGreaterThan(score('gts', 'Go to Sessions'))
  })

  it('scores an exact-length prefix match at the full prefix tier', () => {
    expect(score('settings', 'Settings')).toBe(SCORE_EXACT_PREFIX)
  })

  it('is case-insensitive', () => {
    expect(score('SET', 'settings')).toBe(score('set', 'settings'))
  })

  it('applies the length-difference penalty within a tier', () => {
    const short = score('s', 'Settings')
    const long = score('s', 'Search command history')
    expect(short).toBeGreaterThan(long)
    expect(short).toBeLessThan(SCORE_EXACT_PREFIX)
  })

  it('never lets the penalty drop a match to 0', () => {
    const huge = `g${' x'.repeat(150)}`
    expect(score('g', huge)).toBe(1)
    expect(score('gx', huge)).toBeGreaterThan(0)
  })

  it('keeps a penalized substring match above any subsequence match', () => {
    const substring = score('tings', 'Settings')
    expect(substring).toBeLessThan(SCORE_EXACT_PREFIX)
    expect(substring).toBeGreaterThan(score('stgs', 'Settings'))
  })
})

describe('matchCommands', () => {
  const registry = [
    { id: 'terminal', label: 'Go to Terminal' },
    { id: 'settings', label: 'Go to Settings' },
    { id: 'open-settings', label: 'Open settings' },
    { id: 'gallery', label: 'Browse component gallery' },
  ]

  it('returns the full registry in order for an empty query', () => {
    expect(matchCommands(registry, '')).toEqual(registry)
    expect(matchCommands(registry, '   ')).toEqual(registry)
  })

  it('drops non-matches and sorts by score descending', () => {
    expect(matchCommands(registry, 'sett').map((c) => c.id)).toEqual(['open-settings', 'settings'])
  })

  it('keeps registry order for equal scores', () => {
    expect(matchCommands(registry, 'go to').map((c) => c.id)).toEqual(['terminal', 'settings'])
  })

  it('matches by subsequence across word boundaries', () => {
    expect(matchCommands(registry, 'gll').map((c) => c.id)).toEqual(['gallery'])
  })

  it('returns nothing when nothing matches', () => {
    expect(matchCommands(registry, 'zzz')).toEqual([])
  })
})
