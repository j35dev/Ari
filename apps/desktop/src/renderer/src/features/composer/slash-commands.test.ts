import { describe, expect, it } from 'vitest'
import { matchSlash, SLASH_COMMANDS } from './slash-commands'

describe('matchSlash', () => {
  it('returns the full registry for an empty query', () => {
    expect(matchSlash('')).toEqual(SLASH_COMMANDS)
    expect(matchSlash('   ')).toEqual(SLASH_COMMANDS)
    expect(matchSlash('/')).toEqual(SLASH_COMMANDS)
  })

  it('matches by prefix with or without the leading slash', () => {
    expect(matchSlash('/mo').map((c) => c.name)).toEqual(['model', 'mode'])
    expect(matchSlash('mo').map((c) => c.name)).toEqual(['model', 'mode'])
  })

  it('sorts an exact name match first', () => {
    expect(matchSlash('/mode').map((c) => c.name)).toEqual(['mode', 'model'])
  })

  it('is case-insensitive and ignores trailing argument text', () => {
    expect(matchSlash('/Mode ask').map((c) => c.name)).toEqual(['mode', 'model'])
  })

  it('returns nothing when no command matches', () => {
    expect(matchSlash('/zzz')).toEqual([])
  })
})
