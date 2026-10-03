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
 *
 * Two credentials with different lifetimes come out of pairing. The device key
 * is durable and belongs to the phone; the bearer token is operational, is
 * minted on demand, and is never written to disk. A desktop restart therefore
 * costs a phone nothing: it signs a fresh challenge with the same key and gets
 * a new token, which is what makes a paired device *remembered* rather than
 * merely paired. Only the devices and their revocation state persist.
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
  allowTerminal?: boolean
  redeemedDeviceId?: string
  denied?: boolean
}

export interface PairedDevice {
  deviceId: string
  displayName: string
  projectIds: string[]
  pairedAt: number
  lastSeenAt: number | null
  allowTerminal?: boolean
}

/** A device record as it is written down: the public shape plus its key. */
export interface PersistedDevice extends PairedDevice {
  publicKey: PairingPublicKey
}

/**
 * What a desktop restart may not forget.
 *
 * Device key material is public — it is what the phone signs *with* that is
 * secret — so this is a plain record, not a secret. Bearer tokens are absent
 * on purpose: they are minted per use and live only in memory, so a copy of
 * this file hands out no working credential.
 */
export interface PersistedPairing {
  devices: PersistedDevice[]
  /** Revoked devices stay named here so a phone is told it was revoked. */
  revoked: { deviceId: string; revokedAt: number }[]
}

export interface PairingPersistence {
  save(state: PersistedPairing): void
}

export type PairingResult<T> = ({ ok: true } & T) | { ok: false; code: RemoteErrorCode }

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000
/** Challenges are one-per-attempt and short-lived; a handful is plenty. */
const MAX_CHALLENGES = 256

interface Challenge {
  /** Set for a redemption challenge, which is bound to its invitation. */
  invitationId?: string
  /** Set for a remembered-device challenge, which is bound to its device. */
  deviceId?: string
  expiresAt: number
}

interface Options {
  now?: () => number
  invitationTtlMs?: number
  tokenTtlMs?: number
  persist?: PairingPersistence
  /** Devices and revocations read back from disk at construction. */
  restored?: PersistedPairing
  /**
   * Called whenever the pairing state a user would see has changed: a device
   * asked to pair, the user decided, a device was redeemed or revoked. The
   * desktop turns this into the frame its pairing prompt renders from, so the
   * prompt appears because something happened rather than on a timer.
   */
  onChange?: () => void
}

export class PairingService {
  readonly #invitations = new Map<string, Invitation>()
  readonly #devices = new Map<string, PersistedDevice>()
  readonly #revoked = new Map<string, number>()
  /**
   * Digest of each issued token, mapped to its device. Tokens are stored
   * hashed so a copy of the process's memory does not hand out working
   * credentials, and the digest is what a lookup compares.
   */
  readonly #tokens = new Map<string, { deviceId: string; expiresAt: number }>()
  /**
   * Nonces this server issued, to be signed back. A nonce is the only thing
   * that makes a proof fresh: without one, a signature captured from an
   * earlier pairing would redeem any later invitation using the same device
   * key, which is exactly the case a re-pairing phone creates.
   */
  readonly #challenges = new Map<string, Challenge>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #tokenTtlMs: number
  readonly #persist: PairingPersistence | undefined
  readonly #onChange: (() => void) | undefined

  constructor(options: Options = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = options.invitationTtlMs ?? DEFAULT_TTL_MS
    this.#tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
    this.#persist = options.persist
    this.#onChange = options.onChange
    for (const device of options.restored?.devices ?? []) {
      if (isUsableP256Key(device.publicKey))
        this.#devices.set(device.deviceId, {
          ...device,
          allowTerminal: device.allowTerminal === true,
        })
    }
    for (const entry of options.restored?.revoked ?? []) {
      this.#revoked.set(entry.deviceId, entry.revokedAt)
    }
  }

  /** This service's durable state, for a caller that owns the file. */
  toPersisted(): PersistedPairing {
    return {
      devices: [...this.#devices.values()].map((device) => ({
        ...device,
        projectIds: [...device.projectIds],
        publicKey: { ...device.publicKey },
      })),
      revoked: [...this.#revoked.entries()].map(([deviceId, revokedAt]) => ({
        deviceId,
        revokedAt,
      })),
    }
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
  ): PairingResult<{ pending: PendingDevice; nonce: string }> {
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
      confirmationCode: pairingConfirmationCode(`${request.publicKey.x}.${request.publicKey.y}`),
    }
    invitation.pending = pending
    // The desktop's prompt appears because a device asked, not because a
    // timer fired and looked.
    this.#notify()
    // Issued with the registration, so a client that already knows its own
    // key cannot choose what it will be asked to sign — and bound to this
    // invitation, so the proof cannot be moved to another one.
    return {
      ok: true,
      pending,
      nonce: this.#issueChallenge(invitation.expiresAt, { invitationId }),
    }
  }

  approve(
    invitationId: string,
    projectIds: readonly string[],
    allowTerminal = false,
  ): PairingResult<object> {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return { ok: false, code: 'not_found' }
    if (this.status(invitationId) !== 'pending') return { ok: false, code: 'conflict' }
    if (invitation.pending === undefined) {
      // Nothing to approve yet: approving a request that does not exist would
      // leave an invitation redeemable by whoever asks next.
      return { ok: false, code: 'conflict' }
    }
    invitation.projectIds = [...projectIds]
    invitation.allowTerminal = allowTerminal
    this.#notify()
    return { ok: true }
  }

  deny(invitationId: string): PairingResult<object> {
    const invitation = this.#invitations.get(invitationId)
    if (invitation === undefined) return { ok: false, code: 'not_found' }
    if (this.status(invitationId) !== 'pending') return { ok: false, code: 'conflict' }
    invitation.denied = true
    this.#notify()
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
    if (!this.#proveKey({ invitationId }, pending.publicKey, proof)) {
      invitation.denied = true
      invitation.pending = undefined
      this.#notify()
      return { ok: false, code: 'invalid_signature' }
    }

    const device: PersistedDevice = {
      deviceId: `dev_${randomUUID()}`,
      displayName: pending.displayName,
      projectIds: [...(invitation.projectIds ?? [])],
      publicKey: { ...pending.publicKey },
      pairedAt: this.#now(),
      lastSeenAt: null,
      allowTerminal: invitation.allowTerminal === true,
    }
    invitation.redeemedDeviceId = device.deviceId
    // The request is answered: leaving it in place would keep the desktop's
    // approval prompt on screen for a phone that already paired, and every
    // Approve click after that fails as a conflict.
    invitation.pending = undefined
    this.#devices.set(device.deviceId, device)
    this.#save()
    this.#notify()
    return { ok: true, device: publicDevice(device), token: this.#mintToken(device.deviceId) }
  }

  /**
   * A nonce for a remembered device to sign. Issued whether or not the device
   * exists, so this route answers the same thing to someone guessing ids as it
   * does to the phone it belongs to.
   */
  challenge(deviceId: string): { nonce: string; expiresAt: number } {
    const expiresAt = this.#now() + this.#ttlMs
    return { nonce: this.#issueChallenge(expiresAt, { deviceId }), expiresAt }
  }

  /**
   * Re-authenticates a remembered device without re-pairing, which is what
   * makes a paired device survive a desktop restart: the phone still holds the
   * key, so it can always prove it is the device the user approved. The
   * bearer token it gets back is new and is never the one it used before.
   */
  authorize(
    deviceId: string,
    proof: { nonce: string; signature: string },
  ): PairingResult<{ device: PairedDevice; token: string }> {
    const device = this.#devices.get(deviceId)
    if (device === undefined) {
      // A revocation tombstone outlives the record, so a phone whose access
      // was withdrawn is told that, rather than being turned away in a way
      // that reads like a lost pairing.
      return { ok: false, code: this.#revoked.has(deviceId) ? 'access_revoked' : 'not_found' }
    }
    if (!this.#proveKey({ deviceId }, device.publicKey, proof)) {
      return { ok: false, code: 'invalid_signature' }
    }
    return { ok: true, device: publicDevice(device), token: this.#mintToken(deviceId) }
  }

  /**
   * Resolves a bearer token to the device it was issued to, or `undefined` if
   * nothing was ever issued it. A revoked device has no token, so revocation
   * takes effect here rather than needing a second check at the call site.
   */
  authenticate(token: string): PairedDevice | undefined {
    if (token.length === 0) return undefined
    const digest = tokenDigest(token)
    const entry = this.#tokens.get(digest)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.#now()) {
      this.#tokens.delete(digest)
      return undefined
    }
    const device = this.#devices.get(entry.deviceId)
    return device === undefined ? undefined : publicDevice(device)
  }

  devices(): PairedDevice[] {
    return [...this.#devices.values()].map(publicDevice)
  }

  /** Desktop-only association used to register explicitly managed pairings with Connect. */
  redeemedDeviceId(invitationId: string): string | undefined {
    return this.#invitations.get(invitationId)?.redeemedDeviceId
  }

  isDeviceActive(deviceId: string): boolean {
    return this.#devices.has(deviceId)
  }

  revoke(deviceId: string): boolean {
    const existed = this.#devices.delete(deviceId)
    if (!existed && !this.#revoked.has(deviceId)) return false
    // Drop the credentials too, or a token outlives the device it names.
    for (const [digest, entry] of this.#tokens) {
      if (entry.deviceId === deviceId) this.#tokens.delete(digest)
    }
    this.#revoked.set(deviceId, this.#now())
    this.#save()
    return true
  }

  touch(deviceId: string): void {
    const device = this.#devices.get(deviceId)
    if (device === undefined) return
    device.lastSeenAt = this.#now()
  }

  #issueChallenge(
    expiresAt: number,
    binding: { invitationId?: string; deviceId?: string },
  ): string {
    const nonce = randomBytes(32).toString('base64url')
    this.#pruneChallenges()
    this.#challenges.set(nonce, { expiresAt, ...binding })
    return nonce
  }

  #pruneChallenges(): void {
    const now = this.#now()
    for (const [nonce, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(nonce)
    }
    // A client that keeps asking without ever redeeming must not grow this.
    while (this.#challenges.size >= MAX_CHALLENGES) {
      const oldest = this.#challenges.keys().next()
      if (oldest.done === true) return
      this.#challenges.delete(oldest.value)
    }
  }

  /**
   * Consumes the nonce and verifies the signature over it. Consumption comes
   * first, so a proof cannot be replayed even if the signature is valid: the
   * nonce that made it fresh is gone.
   *
   * The nonce is also bound to what it was issued for, so a redemption proof
   * cannot be moved to another invitation, nor an authorization proof to
   * another device, by presenting it with the right signature attached.
   */
  #proveKey(
    binding: { invitationId: string } | { deviceId: string },
    key: PairingPublicKey,
    proof: { nonce: string; signature: string },
  ): boolean {
    const challenge = this.#challenges.get(proof.nonce)
    if (challenge === undefined) return false
    this.#challenges.delete(proof.nonce)
    if (challenge.expiresAt <= this.#now()) return false
    if (challenge.invitationId !== ('invitationId' in binding ? binding.invitationId : undefined)) {
      return false
    }
    if (challenge.deviceId !== ('deviceId' in binding ? binding.deviceId : undefined)) return false
    return signatureMatches(key, proof)
  }

  #mintToken(deviceId: string): string {
    const token = randomBytes(32).toString('base64url')
    this.#tokens.set(tokenDigest(token), { deviceId, expiresAt: this.#now() + this.#tokenTtlMs })
    return token
  }

  /** Announces a change the desktop's pairing prompt shows, without writing. */
  #notify(): void {
    this.#onChange?.()
  }

  #save(): void {
    this.#persist?.save(this.toPersisted())
    this.#onChange?.()
  }
}

function publicDevice(device: PersistedDevice): PairedDevice {
  return {
    deviceId: device.deviceId,
    displayName: device.displayName,
    projectIds: [...device.projectIds],
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    allowTerminal: device.allowTerminal === true,
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

function signatureMatches(
  key: PairingPublicKey,
  proof: { nonce: string; signature: string },
): boolean {
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
