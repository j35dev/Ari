import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import type { PairingStatus, RemoteErrorCode } from '@ari/contracts/remote'
import { pairingConfirmationCode } from '@ari/contracts/remote'

/**
 * Local device pairing (ADR §18).
 *
 * Deliberately independent of Ari Connect: Tailscale mode has to work with
 * the hosted service unreachable, so everything a device needs to prove who
 * it is lives here.
 *
 * The shape of the trust: a short-lived invitation is displayed as a QR code,
 * which anyone who can see the screen can photograph. So the invitation alone
 * is not enough to pair — the user approves the specific device on the desktop
 * and confirms a code derived from that device's key. The invitation is
 * single-use and redemption is atomic; a second attempt fails closed rather
 * than minting a second device.
 */

export interface PairingPublicKey {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

interface PendingDevice {
  displayName: string
  publicKey: PairingPublicKey
  confirmationCode: string
}

interface Invitation {
  invitationId: string
  gatewayOrigin: string
  expiresAt: number
  createdAt: number
  pending?: PendingDevice
  projectIds?: string[]
  redeemedDeviceId?: string
  denied?: boolean
}

export interface PairedDevice {
  deviceId: string
  displayName: string
  projectIds: string[]
  pairedAt: number
  lastSeenAt: number | null
}

export type PairingResult<T> = { ok: true } & T | { ok: false; code: RemoteErrorCode }

const DEFAULT_TTL_MS = 5 * 60 * 1000

interface Options {
  now?: () => number
  invitationTtlMs?: number
}

export class PairingService {
  readonly #invitations = new Map<string, Invitation>()
  readonly #devices = new Map<string, PairedDevice>()
  /**
   * Digest of each issued token, mapped to its device. Tokens are stored
   * hashed so a copy of the process's memory does not hand out working
   * credentials, and the digest is what a lookup compares.
   */
  readonly #tokens = new Map<string, string>()
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: Options = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.invitationTtlMs ?? DEFAULT_TTL_MS
  }

  begin(gatewayOrigin: string): { invitationId: string; gatewayOrigin: string; expiresAt: number } {
    const invitationId = `inv_${randomUUID()}`
    const createdAt = this.#now()
    const expiresAt = createdAt + this.#ttlMs
    this.#invitations.set(invitationId, { invitationId, gatewayOrigin, createdAt, expiresAt })
    return { invitationId, gatewayOrigin, expiresAt }
  }

  status(invitationId: string): PairingStatus | undefined {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return undefined
    if (invitation.redeemedDeviceId !== undefined) return 'redeemed'
    if (invitation.denied === true) return 'denied'
    // Expiry is computed on read, so a clock that jumps forward cannot leave
    // an invitation that still looks usable.
    if (this.#now() > invitation.expiresAt) return 'expired'
    if (invitation.projectIds !== undefined) return 'approved'
    return 'pending'
  }

  /** The device awaiting the user's decision, for the desktop's prompt. */
  pending(invitationId: string): PendingDevice | undefined {
    return this.#invitations.get(invitationId)?.pending
  }

  request(
    invitationId: string,
    request: { displayName: string; publicKey: PairingPublicKey },
  ): PairingResult<{ pending: PendingDevice }> {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return { ok: false, code: 'not_found' }
    const status = this.status(invitationId)
    if (status === 'expired') return { ok: false, code: 'invitation_expired' }
    if (status !== 'pending') return { ok: false, code: 'conflict' }
    if (!isUsableP256Key(request.publicKey)) {
      return { ok: false, code: 'unsupported_capability' }
    }
    const pending: PendingDevice = {
      displayName: request.displayName,
      publicKey: request.publicKey,
      confirmationCode: pairingConfirmationCode(
        `${request.publicKey.x}.${request.publicKey.y}`,
      ),
    }
    invitation.pending = pending
    return { ok: true, pending }
  }

  approve(invitationId: string, projectIds: readonly string[]): PairingResult<object> {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return { ok: false, code: 'not_found' }
    if (this.status(invitationId) !== 'pending') return { ok: false, code: 'conflict' }
    if (invitation.pending === undefined) {
      // Nothing to approve yet: approving a request that does not exist would
      // leave an invitation redeemable by whoever asks next.
      return { ok: false, code: 'conflict' }
    }
    invitation.projectIds = [...projectIds]
    return { ok: true }
  }

  deny(invitationId: string): PairingResult<object> {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return { ok: false, code: 'not_found' }
    if (this.status(invitationId) !== 'pending') return { ok: false, code: 'conflict' }
    invitation.denied = true
    return { ok: true }
  }

  /**
   * Exchanges a signed nonce for a device record. Atomic by construction: the
   * invitation is claimed before the signature is checked, and a failed check
   * leaves it claimed, so a wrong signature cannot be retried into a pairing.
   */
  redeem(
    invitationId: string,
    proof: { nonce: string; signature: string },
  ): PairingResult<{ device: PairedDevice; token: string }> {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return { ok: false, code: 'not_found' }
    const status = this.status(invitationId)
    if (status === 'redeemed') return { ok: false, code: 'invitation_used' }
    if (status === 'expired') return { ok: false, code: 'invitation_expired' }
    if (status !== 'approved') return { ok: false, code: 'conflict' }

    const pending = invitation.pending
    if (pending === undefined) return { ok: false, code: 'conflict' }

    // Claim it before verifying: a signature check that fails must not leave
    // the invitation open for another attempt. Burned rather than merely
    // claimed, so the desktop reports a refusal instead of a pairing that
    // never happened.
    if (!signatureMatches(pending.publicKey, proof)) {
      invitation.denied = true
      return { ok: false, code: 'invalid_signature' }
    }

    const device: PairedDevice = {
      deviceId: `dev_${randomUUID()}`,
      displayName: pending.displayName,
      projectIds: [...(invitation.projectIds ?? [])],
      pairedAt: this.#now(),
      lastSeenAt: null,
    }
    invitation.redeemedDeviceId = device.deviceId
    const token = randomBytes(32).toString('base64url')
    this.#devices.set(device.deviceId, device)
    this.#tokens.set(tokenDigest(token), device.deviceId)
    return { ok: true, device, token }
  }

  /**
   * Resolves a bearer token to the device it was issued to, or `undefined` if
   * nothing was ever issued it. A revoked device has no token, so revocation
   * takes effect here rather than needing a second check at the call site.
   */
  authenticate(token: string): PairedDevice | undefined {
    if (token.length === 0) return undefined
    const deviceId = this.#tokens.get(tokenDigest(token))
    return deviceId === undefined ? undefined : this.#devices.get(deviceId)
  }

  devices(): PairedDevice[] {
    return [...this.#devices.values()]
  }

  isDeviceActive(deviceId: string): boolean {
    return this.#devices.has(deviceId)
  }

  revoke(deviceId: string): boolean {
    if (!this.#devices.delete(deviceId)) return false
    // Drop the credential too, or the token outlives the device it names.
    for (const [digest, id] of this.#tokens) {
      if (id === deviceId) this.#tokens.delete(digest)
    }
    return true
  }

  touch(deviceId: string): void {
    const device = this.#devices.get(deviceId)
    if (device !== undefined) device.lastSeenAt = this.#now()
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function isUsableP256Key(key: PairingPublicKey | undefined): key is PairingPublicKey {
  if (key === undefined || key === null) return false
  if (key.kty !== 'EC' || key.crv !== 'P-256') return false
  if (typeof key.x !== 'string' || typeof key.y !== 'string') return false
  try {
    createPublicKey({ key, format: 'jwk' })
    return true
  } catch {
    return false
  }
}

function signatureMatches(key: PairingPublicKey, proof: { nonce: string; signature: string }): boolean {
  if (proof.signature.length === 0 || proof.nonce.length === 0) return false
  try {
    return verify(
      'sha256',
      Buffer.from(proof.nonce),
      { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'der' },
      Buffer.from(proof.signature, 'base64'),
    )
  } catch {
    // A malformed signature is a failed signature, not an error to propagate.
    return false
  }
}
