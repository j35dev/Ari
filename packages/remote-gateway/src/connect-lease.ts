import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import {
  connectLeaseClaimsSchema,
  type ConnectJwks,
  type PairingPublicKey,
} from '@ari/contracts/remote'
import type { PersistedDevice } from './pairing'

/** Validates broker-signed membership without replacing the desktop's device approval. */
export class ConnectLeaseVerifier {
  readonly #issuer: string
  readonly #computerId: string
  readonly #keys: Map<string, KeyObject>
  readonly #now: () => number

  constructor(options: {
    issuer: string
    computerId: string
    jwks: ConnectJwks
    now?: () => number
  }) {
    this.#issuer = options.issuer
    this.#computerId = options.computerId
    this.#now = options.now ?? Date.now
    this.#keys = new Map(
      options.jwks.keys.map((key) => [key.kid, createPublicKey({ key, format: 'jwk' })]),
    )
  }

  validate(
    token: string,
    device: PersistedDevice,
  ): { expiresAt: number; projectIds: string[] } | undefined {
    if (token.length > 8192) return undefined
    try {
      const parts = token.split('.')
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        return undefined
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as {
        alg?: string
        kid?: string
      }
      if (header.alg !== 'ES256' || header.kid === undefined) return undefined
      const key = this.#keys.get(header.kid)
      const signature = Buffer.from(signaturePart, 'base64url')
      if (
        key === undefined ||
        signature.length !== 64 ||
        !verify(
          'sha256',
          Buffer.from(`${headerPart}.${payloadPart}`),
          { key, dsaEncoding: 'ieee-p1363' },
          signature,
        )
      )
        return undefined
      const result = connectLeaseClaimsSchema.safeParse(
        JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')),
      )
      if (!result.success) return undefined
      const claims = result.data
      const now = this.#now() / 1000
      if (
        claims.iss !== this.#issuer ||
        claims.aud !== `ari-gateway:${this.#computerId}` ||
        claims.computerId !== this.#computerId ||
        claims.deviceId !== device.deviceId ||
        claims.iat > now + 5 ||
        claims.exp <= now ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 120 ||
        claims.deviceKeyFingerprint !== deviceFingerprint(device.publicKey) ||
        claims.projectIds.some((id) => !device.projectIds.includes(id))
      )
        return undefined
      return { expiresAt: claims.exp * 1000, projectIds: claims.projectIds }
    } catch {
      return undefined
    }
  }
}

function deviceFingerprint(key: PairingPublicKey): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))
    .digest('hex')
}
