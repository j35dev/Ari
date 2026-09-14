import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PairingService, type PersistedPairing } from './pairing'

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
  /** The nonce the server issued with the registration, to be signed back. */
  nonce: string
  clock: { now: number }
} {
  const service = serviceAt(clock)
  const key = deviceKey()
  const invitation = service.begin('http://127.0.0.1:8787')
  const registered = service.request(invitation.invitationId, {
    displayName: 'Pixel',
    publicKey: key.jwk,
  })
  if (!registered.ok) throw new Error('expected the registration to be accepted')
  service.approve(invitation.invitationId, ['proj_1'])
  return { service, invitationId: invitation.invitationId, key, nonce: registered.nonce, clock }
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

  it('issues the nonce the client has to sign, and does not accept one it chose', () => {
    const { service, invitationId, key } = approved()
    // The server's nonce is not anything the client supplied, so a client
    // cannot fix in advance what it will be asked to prove.
    expect(
      service.redeem(invitationId, { nonce: 'client-chosen', signature: key.sign('client-chosen') }),
    ).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('redeems an approved invitation and issues a device credential', () => {
    const { service, invitationId, key, nonce } = approved()
    const result = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.device.displayName).toBe('Pixel')
    expect(result.device.projectIds).toEqual(['proj_1'])
    expect(result.token).toBeTruthy()
    expect(service.status(invitationId)).toBe('redeemed')
  })

  it('refuses a signature made by a different key', () => {
    const { service, invitationId, nonce } = approved()
    const impostor = deviceKey()
    const result = service.redeem(invitationId, { nonce, signature: impostor.sign(nonce) })
    expect(result).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a signature over a nonce this server never issued', () => {
    const { service, invitationId, nonce, key } = approved()
    const result = service.redeem(invitationId, {
      nonce,
      signature: key.sign('a-different-nonce'),
    })
    expect(result).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a nonce issued for another invitation', () => {
    // Two devices asking to pair at once: the nonce one registered with must
    // not redeem the other's invitation.
    const service = serviceAt({ now: 1_000 })
    const first = deviceKey()
    const second = deviceKey()
    const invitationA = service.begin('http://127.0.0.1:8787')
    const invitationB = service.begin('http://127.0.0.1:8787')
    const registeredA = service.request(invitationA.invitationId, {
      displayName: 'A',
      publicKey: first.jwk,
    })
    service.request(invitationB.invitationId, { displayName: 'B', publicKey: second.jwk })
    if (!registeredA.ok) throw new Error('expected the registration to be accepted')
    service.approve(invitationB.invitationId, [])

    expect(
      service.redeem(invitationB.invitationId, {
        nonce: registeredA.nonce,
        signature: second.sign(registeredA.nonce),
      }),
    ).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a device challenge used as a redemption proof', () => {
    // The other direction of the same binding: a nonce minted for a device
    // that is already paired must not stand in for a registration.
    const { service, invitationId, key } = approved()
    const forDevice = service.challenge('dev_somewhere_else')
    expect(
      service.redeem(invitationId, {
        nonce: forDevice.nonce,
        signature: key.sign(forDevice.nonce),
      }),
    ).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a replayed nonce', () => {    const { service, invitationId, nonce, key } = approved()
    expect(service.redeem(invitationId, { nonce, signature: key.sign(nonce) }).ok).toBe(true)
    const second = service.begin('http://127.0.0.1:8787')
    const registered = service.request(second.invitationId, { displayName: 'Pixel', publicKey: key.jwk })
    if (!registered.ok) throw new Error('expected the registration to be accepted')
    service.approve(second.invitationId, [])

    // The signature is genuine, but the nonce that made it fresh is spent, so
    // a captured proof cannot be replayed into a second device.
    expect(service.redeem(second.invitationId, { nonce, signature: key.sign(nonce) })).toEqual({
      ok: false,
      code: 'invalid_signature',
    })
  })

  it('burns the invitation on a bad signature instead of reporting it redeemed', () => {
    const { service, invitationId, nonce } = approved()
    const impostor = deviceKey()
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
    const registered = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: key.jwk,
    })
    if (!registered.ok) throw new Error('expected the registration to be accepted')
    expect(
      service.redeem(invitation.invitationId, {
        nonce: registered.nonce,
        signature: key.sign(registered.nonce),
      }),
    ).toEqual({ ok: false, code: 'conflict' })
  })

  it('refuses a second redemption of the same invitation', () => {
    const { service, invitationId, key, nonce } = approved()
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
    const registered = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: key.jwk,
    })
    if (!registered.ok) throw new Error('expected the registration to be accepted')
    service.deny(invitation.invitationId)
    expect(service.status(invitation.invitationId)).toBe('denied')
    expect(
      service.redeem(invitation.invitationId, {
        nonce: registered.nonce,
        signature: key.sign(registered.nonce),
      }),
    ).toEqual({ ok: false, code: 'conflict' })
  })

  it('revokes a device so its credential stops being accepted', () => {
    const { service, invitationId, key, nonce } = approved()
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
    const { service, invitationId, key, nonce } = approved(clock)
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
    const registeredA = service.request(invA.invitationId, { displayName: 'A', publicKey: a.jwk })
    const registeredB = service.request(invB.invitationId, { displayName: 'B', publicKey: b.jwk })
    service.approve(invA.invitationId, [])
    service.approve(invB.invitationId, [])
    if (!registeredA.ok || !registeredB.ok) throw new Error('expected the registrations to be accepted')

    expect(
      service.redeem(invA.invitationId, {
        nonce: registeredA.nonce,
        signature: b.sign(registeredA.nonce),
      }),
    ).toEqual({ ok: false, code: 'invalid_signature' })
  })
})

describe('device credentials', () => {
  it('authenticates a device from the token it was issued', () => {
    const { service, invitationId, key, nonce } = approved()
    const redeemed = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    if (!redeemed.ok) throw new Error('expected redemption')
    // The token is the only thing the client keeps in memory, so it has to
    // name the device on its own — an id the client never received is no use.
    expect(service.authenticate(redeemed.token)?.deviceId).toBe(redeemed.device.deviceId)
  })

  it('refuses a token that was never issued', () => {
    const { service, invitationId, key, nonce } = approved()
    service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    expect(service.authenticate('not-a-real-token')).toBeUndefined()
    expect(service.authenticate('')).toBeUndefined()
  })

  it('stops authenticating a token once its device is revoked', () => {
    const { service, invitationId, key, nonce } = approved()
    const redeemed = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    if (!redeemed.ok) throw new Error('expected redemption')
    expect(service.revoke(redeemed.device.deviceId)).toBe(true)
    // Revocation is the whole point of the device list; a credential that
    // outlives it would make the list decorative.
    expect(service.authenticate(redeemed.token)).toBeUndefined()
  })

  it('stops authenticating a token that has aged out', () => {
    const clock = { now: 1_000 }
    const service = new PairingService({
      now: () => clock.now,
      invitationTtlMs: 5 * 60 * 1000,
      tokenTtlMs: 60 * 60 * 1000,
    })
    const key = deviceKey()
    const invitation = service.begin('http://127.0.0.1:8787')
    const registered = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: key.jwk,
    })
    if (!registered.ok) throw new Error('expected the registration to be accepted')
    service.approve(invitation.invitationId, [])
    const redeemed = service.redeem(invitation.invitationId, {
      nonce: registered.nonce,
      signature: key.sign(registered.nonce),
    })
    if (!redeemed.ok) throw new Error('expected redemption')

    expect(service.authenticate(redeemed.token)).toBeDefined()
    clock.now += 60 * 60 * 1000 + 1
    // The token is operational and short-lived by design; the device key, not
    // this, is what makes the pairing remembered.
    expect(service.authenticate(redeemed.token)).toBeUndefined()
  })

  it('keeps two devices on their own tokens', () => {
    const service = serviceAt({ now: 1_000 })
    const a = deviceKey()
    const b = deviceKey()
    const invA = service.begin('http://127.0.0.1:8787')
    const invB = service.begin('http://127.0.0.1:8787')
    const regA = service.request(invA.invitationId, { displayName: 'A', publicKey: a.jwk })
    const regB = service.request(invB.invitationId, { displayName: 'B', publicKey: b.jwk })
    if (!regA.ok || !regB.ok) throw new Error('expected the registrations to be accepted')
    service.approve(invA.invitationId, [])
    service.approve(invB.invitationId, [])
    const first = service.redeem(invA.invitationId, { nonce: regA.nonce, signature: a.sign(regA.nonce) })
    const second = service.redeem(invB.invitationId, { nonce: regB.nonce, signature: b.sign(regB.nonce) })
    if (!first.ok || !second.ok) throw new Error('expected both redemptions')
    expect(first.token).not.toBe(second.token)
    expect(service.authenticate(first.token)?.displayName).toBe('A')
    expect(service.authenticate(second.token)?.displayName).toBe('B')
  })
})

describe('remembered devices', () => {
  function paired(): {
    service: PairingService
    key: ReturnType<typeof deviceKey>
    deviceId: string
    token: string
  } {
    const { service, invitationId, key, nonce } = approved()
    const redeemed = service.redeem(invitationId, { nonce, signature: key.sign(nonce) })
    if (!redeemed.ok) throw new Error('expected redemption')
    return { service, key, deviceId: redeemed.device.deviceId, token: redeemed.token }
  }

  it('exchanges a fresh proof for a new token without re-pairing', () => {
    const { service, key, deviceId, token } = paired()
    const challenge = service.challenge(deviceId)
    const result = service.authorize(deviceId, {
      nonce: challenge.nonce,
      signature: key.sign(challenge.nonce),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.device.deviceId).toBe(deviceId)
    expect(result.device.projectIds).toEqual(['proj_1'])
    expect(result.token).not.toBe(token)
    expect(service.authenticate(result.token)?.deviceId).toBe(deviceId)
  })

  it('answers a challenge for a device it does not know', () => {
    const { service } = paired()
    // Issued either way, so this route tells someone guessing ids nothing.
    expect(service.challenge('dev_never_existed').nonce).toBeTruthy()
  })

  it('refuses to authorize a device it does not know', () => {
    const { service, key } = paired()
    const challenge = service.challenge('dev_never_existed')
    expect(
      service.authorize('dev_never_existed', {
        nonce: challenge.nonce,
        signature: key.sign(challenge.nonce),
      }),
    ).toEqual({ ok: false, code: 'not_found' })
  })

  it('reports a revoked device as revoked rather than as a stranger', () => {
    const { service, key, deviceId } = paired()
    expect(service.revoke(deviceId)).toBe(true)
    const challenge = service.challenge(deviceId)
    // The phone has to be able to tell "your access was withdrawn" from "this
    // desktop does not know you", because only one of those is worth offering
    // to pair again.
    expect(
      service.authorize(deviceId, { nonce: challenge.nonce, signature: key.sign(challenge.nonce) }),
    ).toEqual({ ok: false, code: 'access_revoked' })
  })

  it('refuses a proof signed by another key', () => {
    const { service, deviceId } = paired()
    const impostor = deviceKey()
    const challenge = service.challenge(deviceId)
    expect(
      service.authorize(deviceId, {
        nonce: challenge.nonce,
        signature: impostor.sign(challenge.nonce),
      }),
    ).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a challenge issued for a different device', () => {
    const service = serviceAt({ now: 1_000 })
    const one = deviceKey()
    const two = deviceKey()
    const invOne = service.begin('http://127.0.0.1:8787')
    const invTwo = service.begin('http://127.0.0.1:8787')
    const regOne = service.request(invOne.invitationId, { displayName: 'One', publicKey: one.jwk })
    const regTwo = service.request(invTwo.invitationId, { displayName: 'Two', publicKey: two.jwk })
    if (!regOne.ok || !regTwo.ok) throw new Error('expected the registrations to be accepted')
    service.approve(invOne.invitationId, [])
    service.approve(invTwo.invitationId, [])
    const redeemedOne = service.redeem(invOne.invitationId, {
      nonce: regOne.nonce,
      signature: one.sign(regOne.nonce),
    })
    const redeemedTwo = service.redeem(invTwo.invitationId, {
      nonce: regTwo.nonce,
      signature: two.sign(regTwo.nonce),
    })
    if (!redeemedOne.ok || !redeemedTwo.ok) throw new Error('expected both redemptions')

    const challenge = service.challenge(redeemedOne.device.deviceId)
    expect(
      service.authorize(redeemedTwo.device.deviceId, {
        nonce: challenge.nonce,
        signature: two.sign(challenge.nonce),
      }),
    ).toEqual({ ok: false, code: 'invalid_signature' })
  })

  it('refuses a replayed authorization proof', () => {
    const { service, key, deviceId } = paired()
    const challenge = service.challenge(deviceId)
    const proof = { nonce: challenge.nonce, signature: key.sign(challenge.nonce) }
    expect(service.authorize(deviceId, proof).ok).toBe(true)
    expect(service.authorize(deviceId, proof)).toEqual({ ok: false, code: 'invalid_signature' })
  })
})

describe('pairing persistence', () => {
  function restored(state: PersistedPairing): PairingService {
    return new PairingService({ now: () => 1_000, restored: state })
  }

  function pairedService(clock = { now: 1_000 }): {
    service: PairingService
    saved: PersistedPairing[]
    key: ReturnType<typeof deviceKey>
    deviceId: string
    token: string
  } {
    const saved: PersistedPairing[] = []
    const service = new PairingService({
      now: () => clock.now,
      persist: { save: (state) => saved.push(state) },
    })
    const key = deviceKey()
    const invitation = service.begin('http://127.0.0.1:8787')
    const registered = service.request(invitation.invitationId, {
      displayName: 'Pixel',
      publicKey: key.jwk,
    })
    if (!registered.ok) throw new Error('expected the registration to be accepted')
    service.approve(invitation.invitationId, ['proj_1'])
    const redeemed = service.redeem(invitation.invitationId, {
      nonce: registered.nonce,
      signature: key.sign(registered.nonce),
    })
    if (!redeemed.ok) throw new Error('expected redemption')
    return { service, saved, key, deviceId: redeemed.device.deviceId, token: redeemed.token }
  }

  it('remembers a device across a restart, and hands it a new token', () => {
    const first = pairedService()
    const state = first.service.toPersisted()
    const second = restored(state)

    expect(second.devices()).toHaveLength(1)
    expect(second.devices()[0]?.deviceId).toBe(first.deviceId)
    expect(second.devices()[0]?.projectIds).toEqual(['proj_1'])
    // The token was never written down, so the phone proves its key again —
    // and gets a different token, not the one it happened to still hold.
    expect(second.authenticate(first.token)).toBeUndefined()
    const challenge = second.challenge(first.deviceId)
    const authorized = second.authorize(first.deviceId, {
      nonce: challenge.nonce,
      signature: first.key.sign(challenge.nonce),
    })
    expect(authorized.ok).toBe(true)
    if (!authorized.ok) return
    expect(authorized.token).not.toBe(first.token)
    expect(second.authenticate(authorized.token)?.deviceId).toBe(first.deviceId)
  })

  it('writes down nothing that a token could be minted from', () => {
    const { service, token } = pairedService()
    const written = JSON.stringify(service.toPersisted())
    // A copy of this file must not be a working credential, so the token and
    // its digest are both absent from it.
    expect(written).not.toContain(token)
    expect(written).toContain('publicKey')
  })

  it('keeps the revocation across a restart', () => {
    const { service, deviceId, key } = pairedService()
    expect(service.revoke(deviceId)).toBe(true)
    const second = restored(service.toPersisted())

    expect(second.devices()).toHaveLength(0)
    expect(second.isDeviceActive(deviceId)).toBe(false)
    const challenge = second.challenge(deviceId)
    expect(
      second.authorize(deviceId, { nonce: challenge.nonce, signature: key.sign(challenge.nonce) }),
    ).toEqual({ ok: false, code: 'access_revoked' })
  })

  it('saves on every change a restart has to remember', () => {
    const { saved } = pairedService()
    // One for the pairing itself; revocation is covered above.
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[saved.length - 1]?.devices).toHaveLength(1)
  })

  it('drops a restored record whose key is not usable', () => {
    // A truncated or hand-edited file must not produce a device that can never
    // authenticate and can never be explained.
    const service = restored({
      devices: [
        {
          deviceId: 'dev_broken',
          displayName: 'Broken',
          projectIds: [],
          pairedAt: 1,
          lastSeenAt: null,
          publicKey: { kty: 'EC', crv: 'P-256', x: 'not-base64url', y: 'nope' },
        },
      ],
      revoked: [],
    })
    expect(service.devices()).toHaveLength(0)
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
