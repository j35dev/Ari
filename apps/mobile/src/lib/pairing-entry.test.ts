import { describe, expect, it } from 'vitest'
import { readPairingEntry } from './pairing-entry'

const ORIGIN = 'https://phone.test'

describe('what a user enters to pair', () => {
  it('reads the short code from the desktop however it is typed', () => {
    expect(readPairingEntry('k7qf-2m9x', ORIGIN)).toEqual({ kind: 'code', code: 'K7QF2M9X' })
    expect(readPairingEntry(' K7QF 2M9X ', ORIGIN)).toEqual({ kind: 'code', code: 'K7QF2M9X' })
  })

  it('still accepts a pasted pairing link for this computer', () => {
    expect(readPairingEntry(`${ORIGIN}/#pair=inv_installed`, ORIGIN)).toEqual({
      kind: 'invitation',
      invitationId: 'inv_installed',
    })
  })

  it('accepts a bare invitation id', () => {
    expect(readPairingEntry('inv_3f2c9a10-aaaa-bbbb-cccc-000000000000', ORIGIN)).toEqual({
      kind: 'invitation',
      invitationId: 'inv_3f2c9a10-aaaa-bbbb-cccc-000000000000',
    })
  })

  it.each([
    ['https://other.test/#pair=inv_other', /another address/],
    // What Safari's address bar holds after a scan: the app removed the fragment.
    ['https://phone.test/', /8-character code/],
    ['https://user:password@phone.test/#pair=inv_secret', /HTTPS pairing link/],
    ['http://phone.test/#pair=inv_http', /HTTPS pairing link/],
    ['hello', /8-character code/],
  ])('explains what is wrong with %s', (entry, message) => {
    const result = readPairingEntry(entry, ORIGIN)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.message).toMatch(message)
  })
})
