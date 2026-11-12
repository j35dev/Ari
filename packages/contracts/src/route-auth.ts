import { z } from 'zod'
import { pairingKeySchema } from './remote'

/** Canonical audience is an exact origin. Paths, redirects and credentials carry no authority. */
export const routeAudienceSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        ['https:', 'http:'].includes(url.protocol)
      )
    } catch {
      return false
    }
  })
const nonce = z.string().min(32).max(1024)
const hostId = z.string().min(1).max(200)
const time = z.number().int().nonnegative()
export const hostRouteManifestSchema = z
  .object({
    kind: z.literal('ari.routes.v1'),
    hostId,
    publicKey: pairingKeySchema,
    issuedAt: time,
    expiresAt: time,
    routes: z.array(routeAudienceSchema).min(1).max(16),
  })
  .strict()
export const routeProofSchema = z
  .object({
    kind: z.literal('ari.route-proof.v1'),
    hostId,
    audience: routeAudienceSchema,
    nonce,
    issuedAt: time,
    expiresAt: time,
    protocolVersion: z.number().int().positive(),
  })
  .strict()
export const routeChallengeSchema = z
  .object({
    kind: z.literal('ari.route-challenge.v1'),
    hostId,
    audience: routeAudienceSchema,
    clientNonce: nonce,
    deviceId: hostId,
    nonce,
    issuedAt: time,
    expiresAt: time,
  })
  .strict()
const signature = z.string().min(1).max(256)
export const signedHostRouteManifestSchema = z
  .object({ payload: hostRouteManifestSchema, signature })
  .strict()
export const signedRouteProofSchema = z.object({ payload: routeProofSchema, signature }).strict()
export const signedRouteChallengeSchema = z
  .object({ payload: routeChallengeSchema, signature })
  .strict()
export const routeProofRequestSchema = z.object({ audience: routeAudienceSchema, nonce }).strict()
export const routeChallengeRequestSchema = z
  .object({ audience: routeAudienceSchema, clientNonce: nonce, deviceId: hostId })
  .strict()
export const routeAuthorizeRequestSchema = z
  .object({ audience: routeAudienceSchema, deviceId: hostId, nonce, signature })
  .strict()
export type HostRouteManifest = z.infer<typeof hostRouteManifestSchema>
export type RouteProof = z.infer<typeof routeProofSchema>
export type RouteChallenge = z.infer<typeof routeChallengeSchema>
export type SignedHostRouteManifest = z.infer<typeof signedHostRouteManifestSchema>
export type SignedRouteProof = z.infer<typeof signedRouteProofSchema>
export type SignedRouteChallenge = z.infer<typeof signedRouteChallengeSchema>

/** Field order is fixed across runtimes; reject extra fields before signing/verifying. */
export function routeSigningText(payload: HostRouteManifest | RouteProof | RouteChallenge): string {
  if (payload.kind === 'ari.routes.v1') {
    const p = hostRouteManifestSchema.parse(payload)
    return JSON.stringify([
      p.kind,
      p.hostId,
      [p.publicKey.kty, p.publicKey.crv, p.publicKey.x, p.publicKey.y],
      p.issuedAt,
      p.expiresAt,
      p.routes,
    ])
  }
  if (payload.kind === 'ari.route-proof.v1') {
    const p = routeProofSchema.parse(payload)
    return JSON.stringify([
      p.kind,
      p.hostId,
      p.audience,
      p.nonce,
      p.issuedAt,
      p.expiresAt,
      p.protocolVersion,
    ])
  }
  const p = routeChallengeSchema.parse(payload)
  return JSON.stringify([
    p.kind,
    p.hostId,
    p.audience,
    p.clientNonce,
    p.deviceId,
    p.nonce,
    p.issuedAt,
    p.expiresAt,
  ])
}
