import { describe, expect, it } from 'vitest'
import { activeTokenAt } from './active-token'

describe('activeTokenAt', () => {
  it('detects a slash token at the start of the text', () => {
    expect(activeTokenAt('/mo', 3)).toEqual({ kind: 'slash', raw: '/mo', start: 0 })
  })

  it('detects a slash token after whitespace', () => {
    expect(activeTokenAt('run /cle', 8)).toEqual({ kind: 'slash', raw: '/cle', start: 4 })
  })

  it('ignores a slash glued to a preceding word', () => {
    expect(activeTokenAt('abc/', 4)).toBeNull()
  })

  it('ignores uppercase slash queries', () => {
    expect(activeTokenAt('/MO', 3)).toBeNull()
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
    expect(activeTokenAt('run /cle', 4)).toBeNull()
    expect(activeTokenAt('run /cle done', 8)).toEqual({ kind: 'slash', raw: '/cle', start: 4 })
    expect(activeTokenAt('run /cle done', 13)).toBeNull()
  })

  it('returns null for plain text', () => {
    expect(activeTokenAt('hello world', 11)).toBeNull()
    expect(activeTokenAt('', 0)).toBeNull()
  })
})
