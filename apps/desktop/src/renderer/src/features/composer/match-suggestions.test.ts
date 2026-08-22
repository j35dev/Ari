import { describe, expect, it } from 'vitest'
import { matchSuggestions } from './match-suggestions'

const PATHS = [
  'src/app.ts',
  'src/features/composer/Composer.tsx',
  'docs/arch.md',
  'readme.md',
]

describe('matchSuggestions', () => {
  it('returns the first paths for an empty query', () => {
    expect(matchSuggestions(PATHS, '')).toEqual(PATHS)
  })

  it('ranks basename-prefix above path-prefix above substring matches', () => {
    expect(matchSuggestions(PATHS, 'arch')).toEqual(['docs/arch.md'])
    expect(matchSuggestions(['a/docs.md', 'docs/x.md'], 'docs')).toEqual([
      'a/docs.md',
      'docs/x.md',
    ])
    expect(matchSuggestions(['x/my-readme.md', 'src/readme.md'], 'readme')).toEqual([
      'src/readme.md',
      'x/my-readme.md',
    ])
  })

  it('matches case-insensitively anywhere in the path', () => {
    expect(matchSuggestions(PATHS, 'composer')).toEqual(['src/features/composer/Composer.tsx'])
    expect(matchSuggestions(PATHS, 'SRC/APP')).toEqual(['src/app.ts'])
  })

  it('limits the result set', () => {
    const many = Array.from({ length: 12 }, (_, i) => `file-${i}.ts`)
    expect(matchSuggestions(many, '', 8)).toHaveLength(8)
  })

  it('keeps registry order within a tier', () => {
    expect(matchSuggestions(['b/a.ts', 'a.ts'], 'a')).toEqual(['b/a.ts', 'a.ts'])
  })
})
