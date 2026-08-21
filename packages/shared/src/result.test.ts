import { describe, expect, it } from 'vitest'
import { err, formatUnknownError, mapErr, mapOk, ok, unwrap } from './result'

describe('result', () => {
  it('constructs ok and err variants', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 })
    expect(err('bad')).toEqual({ ok: false, error: 'bad' })
  })

  it('maps values and errors independently', () => {
    expect(mapOk(ok(2), (n) => n * 10)).toEqual({ ok: true, value: 20 })
    expect(mapOk(err('e'), (n: number) => n)).toEqual({ ok: false, error: 'e' })
    expect(mapErr(err('e'), (s) => s.length)).toEqual({ ok: false, error: 1 })
    expect(mapErr(ok(1), () => 'x')).toEqual({ ok: true, value: 1 })
  })

  it('unwraps success and throws on error', () => {
    expect(unwrap(ok('v'))).toBe('v')
    expect(() => unwrap(err({ code: 1 }))).toThrow(/code/)
  })

  it('formats unknown thrown values stably', () => {
    expect(formatUnknownError(new TypeError('nope'))).toBe('TypeError: nope')
    expect(formatUnknownError('plain')).toBe('plain')
    expect(formatUnknownError({ a: 1 })).toBe('{"a":1}')
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(formatUnknownError(cyclic)).toBe('[object Object]')
  })
})
