import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PairingService } from './pairing'

function deviceKey(): { jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; sign: (nonce: string) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  return {
    jwk,
    sign: (nonce) =>
      sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  }
}

function serviceAt(clock: { now: number }): PairingService {
  return new PairingService({ now: () => clock.now, invitationTtlMs: 5 * 60 * 1000 })
}

function approved(clock = { now: 1_000 }): {
  service: PairingService
  invitationId: string
  key: ReturnType<typeof deviceKey>
  clock: { now: number }
} {
  const service = serviceAt(clock)
  const key = deviceKey()
  const invitation = service.begin('http://127.0.0.1:8787')
  service.request(invitation.invitationId, { displayName: 'Pixel', publicKey: key.jwk })
  service.approve(invitation.invitationId, ['proj_1'])
  return { service, invitationId: invitation.invitationId, key, clock }
}

describe('pairing', () => {
  it('issues a single-use invitation that expires', () => {
    const clock = { now: 1_000 }
    const service = serviceAt(clock)
    const invitation = service.begin('http://127.0.0.1:8787')

    expect(invitation.invitationId).toBeTruthy()
    expect(invitation.gatewayOrigin).toBe('http://127.0.0.1:8787')
    expect(invitation.expiresAt).toBe(1_000 + 5 * 60 * 1000)
    expect(service.status(invitation.invitationId)).toBe('pending')
  })

  it('reports an invitation past its expiry as expired, not pending', () => {
    const clock = { now: 1_000 }
    const service = serviceAt(clock)
    const invitation = service.begin('http://127.0.0.1:8787')
    clock.now = invitation.expiresAt + 1
    expect(service.status(invitation.invitationId)).toBe('expired')
  })

  it('will not register a device against an expired invitation', () => {
    const clock = { now: 1_000 }
    const service = serviceAt(clock)
    const invitation = service.begin('http://127.0.0.1:8787')
    clock.now = invitation.expiresAt + 1
    const result = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: deviceKey().jwk,
    })
    expect(result).toEqual({ ok: false, code: 'invitation_expired' })
  })

  it('shows the same confirmation code on both screens', () => {
    const service = serviceAt({ now: 1_000 })
    const key = deviceKey()
    const invitation = service.begin('http://127.0.0.1:8787')
    const result = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: key.jwk,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Derived from the registered key, so a swapped key changes the digits.
    expect(result.pending.confirmationCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(result.pending.confirmationCode).toBe(service.pending(invitation.invitationId)?.confirmationCode)
    expect(result.pending.displayName).toBe('Pixel')
  })

  it('gives two different devices two different codes', () => {
    const service = serviceAt({ now: 1_000 })
    const first = service.begin('http://127.0.0.1:8787')
    const second = service.begin('http://127.0.0.1:8787')
    const a = service.request(first.invitationId, { displayName: 'A', publicKey: deviceKey().jwk })
    const b = service.request(second.invitationId, { displayName: 'B', publicKey: deviceKey().jwk })
    expect(a.ok && b.ok && a.pending.confirmationCode !== b.pending.confirmationCode).toBe(true)
  })

  it('redeems an approved invitation and issues a device credential', () => {
    const { service, invitationId, key } = approved()
    const nonce = 'nonce-from-the-server'
    const result = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.device.displayName).toBe('Pixel')
    expect(result.device.projectIds).toEqual(['proj_1'])
    expect(result.token).toBeTruthy()
    expect(service.status(invitationId)).toBe('redeemed')
  })

  it('refuses a signature made by a different key', () => {
    const { service, invitationId } = approved()
    const impostor = deviceKey()
    const nonce = 'nonce-from-the-server'
    const result = service.redeem(invitationId, { nonce, signature: impostor.sign(nonce) })
    expect(result).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a signature over a different nonce', () => {
    const { service, invitationId, key } = approved()
    const result = service.redeem(invitationId, {
      nonce: 'nonce-from-the-server',
      signature: key.sign('a-different-nonce'),
    })
    expect(result).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('burns the invitation on a bad signature instead of reporting it redeemed', () => {
    const { service, invitationId } = approved()
    const impostor = deviceKey()
    const nonce = 'nonce-from-the-server'
    expect(service.redeem(invitationId, { nonce, signature: impostor.sign(nonce) })).toEqual({
      ok: false,
      code: 'invalid_signature',
    })
    // Claimed, so the wrong key cannot try again — but nobody redeemed it, and
    // saying "redeemed" would be a lie the desktop would show the user.
    expect(service.status(invitationId)).toBe('denied')
    expect(service.devices()).toHaveLength(0)
  })

  it('refuses redemption before the user has approved', () => {
    const service = serviceAt({ now: 1_000 })
    const key = deviceKey()
    const invitation = service.begin('http://127.0.0.1:8787')
    service.request(invitation.invitationId, { displayName: 'Pixel', publicKey: key.jwk })
    const nonce = 'n'
    expect(service.redeem(invitation.invitationId, { nonce, signature: key.sign(nonce) })).toEqual({
      ok: false,
      code: 'conflict',
    })
  })

  it('refuses a second redemption of the same invitation', () => {
    const { service, invitationId, key } = approved()
    const nonce = 'n'
    expect(service.redeem(invitationId, { nonce, signature: key.sign(nonce) }).ok).toBe(true)
    // Single use, and the second attempt fails closed rather than minting a
    // second device from a QR code someone photographed.
    expect(service.redeem(invitationId, { nonce, signature: key.sign(nonce) })).toEqual({
      ok: false,
      code: 'invitation_used',
    })
    expect(service.devices()).toHaveLength(1)
  })

  it('lets the user deny a request, and denies rather than ignores', () => {
    const service = serviceAt({ now: 1_000 })
    const key = deviceKey()
    const invitation = service.begin('http://127.0.0.1:8787')
    service.request(invitation.invitationId, { displayName: 'Pixel', publicKey: key.jwk })
    service.deny(invitation.invitationId)
    expect(service.status(invitation.invitationId)).toBe('denied')
    const nonce = 'n'
    expect(service.redeem(invitation.invitationId, { nonce, signature: key.sign(nonce) })).toEqual({
      ok: false,
      code: 'conflict',
    })
  })

  it('revokes a device so its credential stops being accepted', () => {
    const { service, invitationId, key } = approved()
    const nonce = 'n'
    const redeemed = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) return

    expect(service.isDeviceActive(redeemed.device.deviceId)).toBe(true)
    expect(service.revoke(redeemed.device.deviceId)).toBe(true)
    expect(service.isDeviceActive(redeemed.device.deviceId)).toBe(false)
    expect(service.devices()).toHaveLength(0)
  })

  it('reports revoking an unknown device rather than pretending it worked', () => {
    const service = serviceAt({ now: 1_000 })
    expect(service.revoke('dev_never_existed')).toBe(false)
  })

  it('records the last time a device was seen', () => {
    const clock = { now: 1_000 }
    const { service, invitationId, key } = approved(clock)
    const nonce = 'n'
    const redeemed = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    if (!redeemed.ok) throw new Error('expected redemption')
    clock.now = 9_000
    service.touch(redeemed.device.deviceId)
    expect(service.devices()[0]?.lastSeenAt).toBe(9_000)
  })

  it('only verifies against the key registered for that invitation', () => {
    // Two approved invitations in flight; a signature valid for one must not
    // redeem the other.
    const clock = { now: 1_000 }
    const service = serviceAt(clock)
    const a = deviceKey()
    const b = deviceKey()
    const invA = service.begin('http://127.0.0.1:8787')
    const invB = service.begin('http://127.0.0.1:8787')
    service.request(invA.invitationId, { displayName: 'A', publicKey: a.jwk })
    service.request(invB.invitationId, { displayName: 'B', publicKey: b.jwk })
    service.approve(invA.invitationId, [])
    service.approve(invB.invitationId, [])
    const nonce = 'shared-nonce'
    expect(service.redeem(invA.invitationId, { nonce, signature: b.sign(nonce) })).toEqual({
      ok: false,
      code: 'invalid_signature',
    })
  })
})

function redeemOnce(service: PairingService, invitationId: string, key: ReturnType<typeof deviceKey>) {
  const nonce = 'n'
  const result = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
  if (!result.ok) throw new Error(`expected redemption, got ${result.code}`)
  return result
}

describe('device credentials', () => {
  it('authenticates a device from the token it was issued', () => {
    const { service, invitationId, key } = approved()
    const redeemed = redeemOnce(service, invitationId, key)
    // The token is the only thing the client keeps, so it has to name the
    // device on its own — an id the client never received is no use.
    expect(service.authenticate(redeemed.token)?.deviceId).toBe(redeemed.device.deviceId)
  })

  it('refuses a token that was never issued', () => {
    const { service, invitationId, key } = approved()
    redeemOnce(service, invitationId, key)
    expect(service.authenticate('not-a-real-token')).toBeUndefined()
    expect(service.authenticate('')).toBeUndefined()
  })

  it('stops authenticating a token once its device is revoked', () => {
    const { service, invitationId, key } = approved()
    const redeemed = redeemOnce(service, invitationId, key)
    expect(service.revoke(redeemed.device.deviceId)).toBe(true)
    // Revocation is the whole point of the device list; a credential that
    // outlives it would make the list decorative.
    expect(service.authenticate(redeemed.token)).toBeUndefined()
  })

  it('keeps two devices on their own tokens', () => {
    const service = serviceAt({ now: 1_000 })
    const a = deviceKey()
    const b = deviceKey()
    const invA = service.begin('http://127.0.0.1:8787')
    const invB = service.begin('http://127.0.0.1:8787')
    service.request(invA.invitationId, { displayName: 'A', publicKey: a.jwk })
    service.request(invB.invitationId, { displayName: 'B', publicKey: b.jwk })
    service.approve(invA.invitationId, [])
    service.approve(invB.invitationId, [])
    const first = redeemOnce(service, invA.invitationId, a)
    const second = redeemOnce(service, invB.invitationId, b)
    expect(first.token).not.toBe(second.token)
    expect(service.authenticate(first.token)?.displayName).toBe('A')
    expect(service.authenticate(second.token)?.displayName).toBe('B')
  })
})

describe('pairing public key material', () => {
  it('rejects a key that is not a P-256 EC key', () => {
    const service = serviceAt({ now: 1_000 })
    const invitation = service.begin('http://127.0.0.1:8787')
    const result = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: { kty: 'RSA', crv: 'P-256', x: 'a', y: 'b' } as never,
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a real P-256 key', () => {
    const service = serviceAt({ now: 1_000 })
    const invitation = service.begin('http://127.0.0.1:8787')
    expect(
      service.request(invitation.invitationId, { displayName: 'Pixel', publicKey: deviceKey().jwk })
        .ok,
    ).toBe(true)
    // And the material really is usable as a key.
    expect(() => createPublicKey({ key: deviceKey().jwk, format: 'jwk' })).not.toThrow()
  })
})
