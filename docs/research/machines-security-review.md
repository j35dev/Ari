# Machines security review

Status: initial authoring audit; final integrated snapshot review pending.
Reviewer: security worker, branch `machines/security-review`, 2026-11-11.

Scope: `feat/machines`, `machines/core`, `machines/mobile-access`,
`machines/desktop-ui`, and `machines/mobile-ui`. Worker code was read only.
Only this report is committed. No live Ari, Tailscale, settings, or devices were
changed; no push or PR was made.

## Initial findings

### S1 — High / P1: anonymous identity merges an unapproved origin into a paired credential

Snapshot: `machines/core` 7119a5a61cfd02b8db73fea54ea8c1b88f0c1b3c.
Locations: `apps/desktop/src/main/machines-registry.ts:46`,
`apps/desktop/src/main/machines.ts:352`,
`packages/remote-client/src/session.ts:416`.

`MachinesRegistry.add` merges a new origin into an existing record solely when
its unauthenticated public `machineId` matches. `#routeOptions` then permits the
existing paired key to authenticate through that origin when the first route
is unreachable. A malicious tailnet endpoint can copy the target's public ID,
be added as a different computer, and proxy challenges and authorization to the
real target. The existing client signs the real target's nonce; the malicious
endpoint receives a valid token for an already approved device without a new
host approval. DNS pinning and valid per-origin TLS do not bind this new origin
to the target's public ID or approval. The endpoint can also return invented
session/file/receipt data under the original machine's state scope.

Required fix: independently pair each new origin and never reuse a credential
based on anonymous identity equality. Authenticated host route binding would
require a separately designed host proof; a public ID alone is insufficient.
Coordinator confirmed the finding and assigned the independent-origin fix to
core. Isolated challenge-relay reproduction and fix verification are pending.

### S2 — High / P1: desktop discards receipts on uncertain named failures

Locations: `apps/desktop/src/renderer/src/features/machines/remote-client.ts:81`,
`packages/remote-gateway/src/gateway.ts:157`,
`packages/remote-gateway/src/gateway.ts:568` (grants worker; lines to freeze).

`submitReceipt` treats every error matching `remoteErrorSchema` as definitive
and deletes the saved command. This includes `internal_error` and `conflict`.
The gateway can return `internal_error` after execution, including a failure
persisting the completed receipt, or when execution throws after a side effect.
The renderer then permits the user to submit a fresh command with a new key,
duplicating a prompt, creation, integration, or terminal input whose original
outcome was uncertain. A reported in-flight `conflict` likewise does not prove
that the original command was not accepted. Transport `unreachable` itself is
outside the schema and does retain the receipt; that case is not the finding.

Required fix: retain exact receipts for `internal_error`, in-flight/unknown
`conflict`, and transport/IPC uncertainty. Clear only proven pre-dispatch refusal
or confirmed completion. Add tests for an accepted command followed by a named
internal error and for in-flight receipt reconciliation.

### S3 — High / P1: host startup can finish after remote access was stopped

Locations: `apps/desktop/src/main/remote.ts:120`,
`apps/desktop/src/main/remote.ts:189`,
`apps/desktop/src/main/remote.ts:213` (grants worker; lines to freeze).

`start` checks `#gateway` only before asynchronous project refresh and listener
creation. `stop` has no generation cancellation or shared in-flight startup.
If stopping or shutdown occurs while project refresh/listen is pending, stop can
return with remote access disabled, then the old start installs a live gateway.
Two overlapping starts can also construct listeners with different pairing
objects and overwrite the tracked listener. `startManaged`/`stopManaged` have
the equivalent late listener publication boundary. A leftover listener can
retain stale pairing state and credentials, so later revocation/stop acts on a
different instance.

Required fix: serialize lifecycle operations and/or fence every asynchronous
publication by generation; close listeners created by cancelled starts. Stop
must await or cancel all pending start work. Add deterministic delayed-start,
double-start, managed-stop, and shutdown tests. This boundary exists partly in
the prior implementation but is still a release requirement for Machines.

### S4 — Medium / P2: a managed shell survives its signed membership lease

Locations: `apps/desktop/src/main/remote-terminals.ts:20`,
`apps/desktop/src/main/remote-terminals.ts:47`,
`apps/desktop/src/main/remote.ts:131`,
`packages/remote-gateway/src/gateway.ts:673` (grants worker; lines to freeze).

Connect HTTP requests correctly use the signed project list and event streams
expire with their lease. A created PTY stores only device/session/project IDs;
the watchdog asks whether the local paired device still has terminal access.
It retains no managed lease or membership expiry. After the lease expires or
broker membership is withdrawn, a previously started shell/process continues as
the host user until local device/grant revocation or host shutdown. This does
not grant new authenticated HTTP reads/writes after lease expiry, but it leaves
the already executing managed terminal outside the short-lived access lifecycle.

Required fix or explicit design decision: associate managed shells with their
authorization lifetime, renew through a verified current lease, and stop them
on membership expiry/revocation; keep private Tailscale shells on their explicit
local device grant. Test managed lease expiry separately from local grant
withdrawal, which already has a one-second watchdog.

## Verification and outstanding work

Initial findings are based on source/control-flow inspection. Focused isolated
reproduction is pending; no broad build or test claim is made. All validation
must run through `scripts/coordination/run-heavy.mjs` with the shared lease and
resource gates, after a WIP commit. Final integrated snapshot, exact fix review,
complete branch coverage, and hardware/managed-service checks remain pending.
