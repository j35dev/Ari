import { describe, expect, it } from 'vitest'
import { activeTokenAt } from './active-token'

describe('activeTokenAt', () => {
  it('ignores slash text now that the slash popup is removed', () => {
    expect(activeTokenAt('/mo', 3)).toBeNull()
    expect(activeTokenAt('run /cle', 8)).toBeNull()
    expect(activeTokenAt('abc/', 4)).toBeNull()
  })

  it('detects a mention token with path characters', () => {
    expect(activeTokenAt('see @src/app.ts-x', 17)).toEqual({
      kind: 'mention',
      raw: '@src/app.ts-x',
      start: 4,
    })
  })

  it('detects a bare mention at the start', () => {
    expect(activeTokenAt('@', 1)).toEqual({ kind: 'mention', raw: '@', start: 0 })
  })

  it('returns the token only when the caret sits at its end', () => {
    expect(activeTokenAt('see @src/app', 4)).toBeNull()
    expect(activeTokenAt('see @src/app now', 12)).toEqual({
      kind: 'mention',
      raw: '@src/app',
      start: 4,
    })
    expect(activeTokenAt('see @src/app now', 16)).toBeNull()
  })

  it('returns null for plain text', () => {
    expect(activeTokenAt('hello world', 11)).toBeNull()
    expect(activeTokenAt('', 0)).toBeNull()
  })
})
