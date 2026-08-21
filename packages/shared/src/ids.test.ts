import { describe, expect, it } from 'vitest'
import { idPrefixes, newId, newTypedId } from './ids'

describe('ids', () => {
  it('prefixes generated ids', () => {
    const id = newId('sess')
    expect(id.startsWith('sess_')).toBe(true)
    expect(id.length).toBeGreaterThan('sess_'.length)
  })

  it('generates unique ids', () => {
    const seen = new Set(Array.from({ length: 500 }, () => newId('x')))
    expect(seen.size).toBe(500)
  })

  it('supports typed prefixes', () => {
    expect(newTypedId('turn').startsWith(`${idPrefixes.turn}_`)).toBe(true)
    expect(newTypedId('ckpt').startsWith('ckpt_')).toBe(true)
  })
})
