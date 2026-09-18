import { describe, expect, it } from 'vitest'
import { sessionIdOf } from './command-result'

describe('sessionIdOf', () => {
  it('reads the session id from inside the gateway envelope', () => {
    expect(sessionIdOf({ ok: true, result: { sessionId: 'sess_new' } })).toBe('sess_new')
  })

  it('still reads a bare answer', () => {
    expect(sessionIdOf({ sessionId: 'sess_new' })).toBe('sess_new')
  })

  it('answers null when no id is present', () => {
    expect(sessionIdOf({ ok: true, result: { accepted: true } })).toBeNull()
    expect(sessionIdOf(null)).toBeNull()
    expect(sessionIdOf('sess_new')).toBeNull()
  })
})
