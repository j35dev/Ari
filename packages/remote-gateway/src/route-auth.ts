import { createPublicKey, sign, type KeyObject } from 'node:crypto'
import { pairingKeySchema, type PairingPublicKey } from '@ari/contracts/remote'
import {
  routeAudienceSchema,
  routeSigningText,
  type HostRouteManifest,
  type RouteProof,
  type RouteChallenge,
} from '@ari/contracts/route-auth'

export interface HostRouteSigner {
  readonly hostId: string
  readonly publicKey: PairingPublicKey
  sign(payload: HostRouteManifest | RouteProof | RouteChallenge): string
}
export function createHostRouteSigner(hostId: string, privateKey: KeyObject): HostRouteSigner {
  if (
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new Error('Invalid host route signing key.')
  return {
    hostId,
    publicKey: pairingKeySchema.parse(createPublicKey(privateKey).export({ format: 'jwk' })),
    sign: (payload) => {
      if (payload.hostId !== hostId) throw new Error('Host signing identity mismatch.')
      return sign('sha256', Buffer.from(routeSigningText(payload)), {
        key: privateKey,
        dsaEncoding: 'der',
      }).toString('base64')
    },
  }
}
export interface RouteAuthority {
  signer: HostRouteSigner
  /** Complete, verified, host-owned exposures. Never allowedOrigins or request headers. */
  servedOrigins: () => readonly string[]
  /** This listener's configured exposure, independent of the request. null disables reuse. */
  audience: () => string | null
}
export function ownedRouteAudience(authority: RouteAuthority): string | null {
  const audience = authority.audience()
  if (audience === null) return null
  routeAudienceSchema.parse(audience)
  if (!authority.servedOrigins().includes(audience)) return null
  return audience
}
