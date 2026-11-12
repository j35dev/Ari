import type { PairingPublicKey } from '@ari/contracts/remote'
import { routeSigningText, signedHostRouteManifestSchema, signedRouteChallengeSchema,
  signedRouteProofSchema, type HostRouteManifest, type RouteChallenge, type RouteProof,
  type SignedHostRouteManifest } from '@ari/contracts/route-auth'
import { RemoteError, type GatewayClient } from './gateway-client'
import type { DeviceCredential } from './credential'

export interface PinnedRouteIdentity {
  hostId: string
  publicKey: PairingPublicKey
  credentialOrigin: string
}
export interface DeviceAuthorization {
  deviceId: string
  token: string
  projectIds: string[]
  allowTerminal?: boolean
}
function reject(): never {
  throw new RemoteError('invalid_signature', 'This route could not prove the saved computer identity. Add or verify its route on the original computer.')
}
function fresh(payload: {issuedAt: number; expiresAt: number}, maximumTtl: number, now: number): void {
  if (payload.issuedAt > now + 5000 || payload.expiresAt <= now ||
    payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > maximumTtl) reject()
}
export function sameHostKey(a: PairingPublicKey, b: PairingPublicKey): boolean {
  return a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y
}
/** Strict ASN.1 DER to WebCrypto's fixed-width P-256 signature. */
function rawSignature(signature: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>
  try { bytes = Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)) } catch { return reject() }
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return reject()
  const raw = new Uint8Array(64)
  let offset = 2
  for (let part = 0; part < 2; part++) {
    if (bytes[offset++] !== 2) return reject()
    const length = bytes[offset++]!
    if (length < 1 || length > 33 || offset + length > bytes.length) return reject()
    let integer = bytes.slice(offset, offset + length)
    if ((integer[0]! & 128) !== 0) return reject()
    if (integer.length > 1 && integer[0] === 0) {
      if ((integer[1]! & 128) === 0) return reject()
      integer = integer.slice(1)
    }
    if (integer.length > 32) return reject()
    raw.set(integer, (part + 1) * 32 - integer.length)
    offset += length
  }
  if (offset !== bytes.length) return reject()
  return raw
}
async function verifyPayload(payload: HostRouteManifest | RouteProof | RouteChallenge, signature: string, key: PairingPublicKey): Promise<void> {
  try {
    const imported = await crypto.subtle.importKey('jwk', key, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify'])
    if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, imported, rawSignature(signature),
      new TextEncoder().encode(routeSigningText(payload)))) reject()
  } catch { reject() }
}
/** Caller must obtain this response authenticated on an independently approved origin. */
export async function verifyHostManifest(raw: unknown, origin: string, expectedHostId: string | undefined,
  pin: PinnedRouteIdentity | null, now = Date.now()): Promise<SignedHostRouteManifest> {
  const manifest = signedHostRouteManifestSchema.parse(raw)
  fresh(manifest.payload, 5 * 60_000, now)
  if (!manifest.payload.routes.includes(origin) ||
    (expectedHostId !== undefined && manifest.payload.hostId !== expectedHostId) ||
    (pin !== null && (pin.hostId !== manifest.payload.hostId || pin.credentialOrigin !== origin ||
      !sameHostKey(pin.publicKey, manifest.payload.publicKey)))) reject()
  await verifyPayload(manifest.payload, manifest.signature, pin?.publicKey ?? manifest.payload.publicKey)
  return manifest
}
export async function verifyRoute(client: GatewayClient, pin: PinnedRouteIdentity, signal?: AbortSignal): Promise<RouteProof> {
  signal?.throwIfAborted()
  const nonce = crypto.randomUUID() + crypto.randomUUID()
  const proof = signedRouteProofSchema.parse(await client.routeProof(nonce))
  signal?.throwIfAborted()
  fresh(proof.payload, 30_000, Date.now())
  if (proof.payload.hostId !== pin.hostId || proof.payload.audience !== client.origin || proof.payload.nonce !== nonce) reject()
  await verifyPayload(proof.payload, proof.signature, pin.publicKey)
  signal?.throwIfAborted()
  return proof.payload
}
/** No device ID or signature is sent until this destination proves pinned ownership. */
export async function authorizeRoute(client: GatewayClient, pin: PinnedRouteIdentity,
  credential: DeviceCredential, deviceId: string, signal?: AbortSignal): Promise<DeviceAuthorization> {
  const proof = await verifyRoute(client, pin, signal)
  if (proof.protocolVersion !== 1) throw new RemoteError('unsupported_version', 'The verified computer uses an unsupported Ari protocol.')
  const clientNonce = crypto.randomUUID() + crypto.randomUUID()
  const challenge = signedRouteChallengeSchema.parse(await client.routeChallenge(deviceId, clientNonce))
  signal?.throwIfAborted()
  fresh(challenge.payload, 30_000, Date.now())
  const payload = challenge.payload
  if (payload.hostId !== pin.hostId || payload.audience !== client.origin ||
    payload.deviceId !== deviceId || payload.clientNonce !== clientNonce) reject()
  await verifyPayload(payload, challenge.signature, pin.publicKey)
  signal?.throwIfAborted()
  const signature = await credential.sign(routeSigningText(payload))
  signal?.throwIfAborted()
  const authorized = await client.routeAuthorize(deviceId, payload.nonce, signature)
  signal?.throwIfAborted()
  if (authorized.deviceId !== deviceId || typeof authorized.token !== 'string' || authorized.token.length === 0 ||
    !Array.isArray(authorized.projectIds) || authorized.projectIds.some((id) => typeof id !== 'string')) reject()
  return authorized
}
