import { describe, expect, it } from 'vitest'
import {
  REMOTE_ANONYMOUS_OPERATIONS,
  REMOTE_PROTOCOL_VERSION,
  pairingConfirmationCode,
  remoteClientMessageSchema,
  remoteCommandEnvelopeSchema,
  remoteErrorCodeSchema,
  remoteOperationSchema,
  remoteOriginSchema,
  remoteServerMessageSchema,
  remoteSnapshotSchema,
  requiresAuthentication,
} from './remote'

describe('remote contract', () => {
  it('declares a protocol version', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBeGreaterThan(0)
  })

  it('has no route for operations the design defers', () => {
    // ADR §3 defers these; the gateway cannot perform what is not declared,
    // so their absence here is the enforcement, not a missing feature.
    for (const deferred of [
      'terminal.open',
      'terminal.write',
      'shell.exec',
      'provider.login',
      'fs.writeTextFile',
      'settings.setApiKey',
      'project.addRoot',
    ]) {
      expect(remoteOperationSchema.safeParse(deferred).success).toBe(false)
    }
  })

  it('rejects an operation that merely looks plausible', () => {
    expect(remoteOperationSchema.safeParse('session.delete').success).toBe(false)
    expect(remoteOperationSchema.safeParse('*').success).toBe(false)
    expect(remoteOperationSchema.safeParse('session').success).toBe(false)
  })

  it('requires an idempotency key on every mutating command', () => {
    const mutating = remoteCommandEnvelopeSchema.safeParse({
      op: 'session.prompt',
      sessionId: 'sess_1',
      text: 'hello',
      clientCommandId: 'c-1',
    })
    expect(mutating.success).toBe(false)
    expect(
      remoteCommandEnvelopeSchema.safeParse({
        op: 'session.prompt',
        sessionId: 'sess_1',
        text: 'hello',
        clientCommandId: 'c-1',
        idempotencyKey: 'key-0123456789',
      }).success,
    ).toBe(true)
  })

  it('rejects an idempotency key too short to be unique', () => {
    expect(
      remoteCommandEnvelopeSchema.safeParse({
        op: 'session.prompt',
        sessionId: 'sess_1',
        text: 'hello',
        clientCommandId: 'c-1',
        idempotencyKey: 'abc',
      }).success,
    ).toBe(false)
  })

  it('carries the exact approval option, not a collapsed decision', () => {
    const parsed = remoteCommandEnvelopeSchema.safeParse({
      op: 'approval.respond',
      sessionId: 'sess_1',
      approvalId: 'ap_1',
      optionId: 'acceptForSession',
      clientCommandId: 'c-2',
      idempotencyKey: 'key-0123456789',
    })
    expect(parsed.success).toBe(true)
    // The coarse three-valued vocabulary is not part of the remote surface:
    // a remote client always has the offered options in hand.
    expect(
      remoteCommandEnvelopeSchema.safeParse({
        op: 'approval.respond',
        sessionId: 'sess_1',
        approvalId: 'ap_1',
        decision: 'always-allow',
        clientCommandId: 'c-3',
        idempotencyKey: 'key-0123456789',
      }).success,
    ).toBe(false)
  })

  it('refuses to let a remote client raise the permission ceiling', () => {
    // The desktop's ceiling is authoritative; mobile cannot move it.
    expect(
      remoteCommandEnvelopeSchema.safeParse({
        op: 'session.create',
        projectId: 'p1',
        permissionMode: 'full',
        clientCommandId: 'c-4',
        idempotencyKey: 'key-0123456789',
      }).success,
    ).toBe(false)
  })

  it('does not accept a wildcard origin anywhere', () => {
    // ADR §5: origins are matched exactly. `'*'` has to fail the schema
    // rather than match everything, and no message may carry one.
    expect(remoteOriginSchema.safeParse('*').success).toBe(false)
    expect(remoteOriginSchema.safeParse('https://*').success).toBe(false)
    expect(remoteOriginSchema.safeParse('http://127.0.0.1:8787').success).toBe(true)
    expect(remoteServerMessageSchema.safeParse({ type: 'events.desync', sessionId: 's', reason: 'r', origin: '*' }).success).toBe(true)
    // ...and the field is stripped, because no server message declares one.
    const parsed = remoteServerMessageSchema.parse({
      type: 'events.desync',
      sessionId: 's',
      reason: 'r',
      origin: '*',
    })
    expect(parsed).not.toHaveProperty('origin')
  })

  it('keeps a snapshot and its high-water mark together', () => {
    const parsed = remoteSnapshotSchema.safeParse({
      sessionId: 'sess_1',
      seq: 42,
      status: 'idle',
      pendingApprovals: [],
    })
    expect(parsed.success).toBe(true)
    expect(remoteSnapshotSchema.safeParse({ sessionId: 'sess_1', status: 'idle' }).success).toBe(
      false,
    )
  })

  it('derives a confirmation code that is stable and comparable by eye', () => {
    const a = pairingConfirmationCode('jwk-a')
    const b = pairingConfirmationCode('jwk-a')
    const c = pairingConfirmationCode('jwk-b')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    // Short enough to read across two screens, and grouped so it is.
    expect(a).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
  })

  it('names its failures rather than returning a bare status', () => {
    expect(remoteErrorCodeSchema.safeParse('unsupported_capability').success).toBe(true)
    expect(remoteErrorCodeSchema.safeParse('access_revoked').success).toBe(true)
    expect(remoteErrorCodeSchema.safeParse('unknown_error_500').success).toBe(false)
  })

  it('distinguishes a client hello from a command', () => {
    expect(
      remoteClientMessageSchema.safeParse({ type: 'events.subscribe', sessionId: 's', fromSeq: 0 })
        .success,
    ).toBe(true)
    expect(remoteClientMessageSchema.safeParse({ type: 'events.subscribe', sessionId: 's' }).success)
      .toBe(true)
    expect(remoteClientMessageSchema.safeParse({ type: 'command' }).success).toBe(false)
  })
})

describe('pairing authority', () => {
  it('declares the step the phone actually performs', () => {
    // A device registers its key before it holds any credential, so this is
    // the one pairing operation that has to exist on the remote surface.
    expect(remoteOperationSchema.safeParse('pairing.request').success).toBe(true)
  })

  it('keeps the two decisions that belong to the desktop off the remote surface', () => {
    // Minting an invitation and approving a device are the user's acts, made
    // at the desktop. Reachable anonymously, `approve` would let whoever
    // photographed the QR code approve their own device, and the confirmation
    // code on screen — the whole point of the flow — would confirm nothing.
    expect(remoteOperationSchema.safeParse('pairing.begin').success).toBe(false)
    expect(remoteOperationSchema.safeParse('pairing.approve').success).toBe(false)
  })

  it('leaves only the credential-less steps unauthenticated', () => {
    // Everything the phone does after redemption presents its token; if any
    // of these drifted into the anonymous set, a failure to authenticate
    // would fall through to a working route.
    for (const open of ['gateway.info', 'pairing.request', 'pairing.status', 'pairing.redeem'] as const) {
      expect(requiresAuthentication(open)).toBe(false)
    }
    for (const guarded of [
      'session.list',
      'session.prompt',
      'approval.respond',
      'device.revoke',
    ] as const) {
      expect(requiresAuthentication(guarded)).toBe(true)
    }
  })

  it('does not advertise an anonymous operation it cannot serve', () => {
    for (const operation of REMOTE_ANONYMOUS_OPERATIONS) {
      expect(remoteOperationSchema.safeParse(operation).success).toBe(true)
    }
  })

  it('keeps every command behind a device credential', () => {
    // The gateway relies on this: a command handler that has parsed an
    // envelope can treat the authenticated device as present rather than
    // branching on a device that cannot be missing. Adding an anonymous
    // command would silently break that, so it fails here first.
    for (const option of remoteCommandEnvelopeSchema.options) {
      expect(requiresAuthentication(option.shape.op.value)).toBe(true)
    }
  })
})
