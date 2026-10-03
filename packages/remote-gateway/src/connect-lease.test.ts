import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PersistedDevice } from './pairing'
import { ConnectLeaseVerifier } from './connect-lease'

function setup() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as PersistedDevice['publicKey']
  const device: PersistedDevice = {
    deviceId: 'dev_phone',
    displayName: 'Phone',
    projectIds: ['p1', 'p2'],
    publicKey: jwk,
    pairedAt: 1,
    lastSeenAt: null,
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('hex')
  const verifier = new ConnectLeaseVerifier({
    issuer: 'https://connect.example',
    computerId: 'comp_12345678',
    jwks: { keys: [{ ...jwk, alg: 'ES256', use: 'sig', kid: 'trusted' }] },
    now: () => 100_000,
  })
  const claims = {
    iss: 'https://connect.example',
    aud: 'ari-gateway:comp_12345678',
    sub: 'member',
    computerId: 'comp_12345678',
    deviceId: device.deviceId,
    deviceKeyFingerprint: fingerprint,
    projectIds: ['p1'],
    iat: 100,
    exp: 220,
    jti: 'unique',
  }
  function token(patch: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'trusted', ...header })).toString(
      'base64url',
    )
    const p = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url')
    return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  }
  return { verifier, device, token }
}

describe('managed membership leases', () => {
  it('accepts an authentic bounded lease and narrows project access to its scope', () => {
    const { verifier, device, token } = setup()
    expect(verifier.validate(token(), device)).toEqual({ expiresAt: 220_000, projectIds: ['p1'] })
  })

  it.each([
    { iss: 'https://evil.example' },
    { aud: 'ari-gateway:other' },
    { computerId: 'other' },
    { deviceId: 'other' },
    { deviceKeyFingerprint: '0'.repeat(64) },
    { projectIds: ['ungranted'] },
    { exp: 100 },
    { iat: 106 },
    { exp: 221 },
    { exp: 99 },
  ])('refuses wrong identity, scope or lifetime: %j', (patch) => {
    const { verifier, device, token } = setup()
    expect(verifier.validate(token(patch), device)).toBeUndefined()
  })

  it('rejects unknown keys, wrong algorithms, tampering and malformed tokens', () => {
    const { verifier, device, token } = setup()
    for (const value of [
      token({}, { kid: 'unknown' }),
      token({}, { alg: 'HS256' }),
      token().replace(/.$/, '!'),
      'invalid',
      'a'.repeat(8193),
    ]) {
      expect(verifier.validate(value, device)).toBeUndefined()
    }
  })
})
