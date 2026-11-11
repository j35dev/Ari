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
Coordinator confirmed the finding. Fix
`02158cd79be05914d57faf396690c95064c936c5` removes anonymous merging and all
cross-origin credential failover; source inspection verifies independently
paired origins. Core also authored an adversarial copied-ID regression. The
reviewer's isolated P-256 challenge-relay reproduction is queued through the
shared validation runner against both immutable commits.

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

Desktop correction `5ce1d560bd1503ae4ab8439ffa2c45f57e448a9a` retains these
errors, validates creation/attachment results before forgetting the receipt,
and resends only after a user explicitly retries a `not_found` status. Source
policy and authored accepted-then-internal-error/in-flight-conflict tests were
reviewed. Final integrated verification remains pending.

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

### S5 — High / P1: unsuccessful durable revocation is silently acknowledged

Snapshot inspected: grants `5828c4eab9c3938e289295a6cfa2c1ac8ef93766` plus
the worker's ongoing lifecycle edits. Location:
`apps/desktop/src/main/remote.ts:547` (`#write`, before final line freeze),
`packages/remote-gateway/src/pairing.ts:449` (`revoke`/grant persistence).

The host record writer catches all mkdir/write/rename failures and only logs.
Pairing revocation and grant withdrawal therefore appear successful even when
`devices.json` still contains the old approved device/terminal grant. If the
profile volume is full, read-only, or denies the rename, then the host restarts,
the old device or grant is restored and that key can authorize again. Runtime
token deletion and the terminal watchdog do not make this revocation durable.
This is an inherited security boundary, not introduced by allProjects.

Required fix: propagate sensitive persistence failures and fail closed rather
than reporting durable success. Keep runtime denial in effect, explain the
unsaved security change, and prevent restart from reauthorizing stale records
when durable revocation cannot be established. Cover injected filesystem
failures for approval, revocation and terminal withdrawal, plus restart proofs.

### S6 — High / P1: missing deduplication state is treated as proof a mutation never ran

Locations: `packages/remote-client/src/session.ts:496` (`#reconcile`, core
lifecycle edits), `packages/remote-gateway/src/idempotency.ts:146` (`fromJSON`),
`packages/remote-gateway/src/idempotency.ts:170` (`#evict`), and the host record
writer in S5.

Shared `RemoteSession.send` automatically resends after a lost response if
`command.status` reports `not_found`. That result can mean the command never
arrived, but can also mean the durable claim write failed, the restore file was
corrupt (silently reset to empty), or the receipt was evicted. The 1,000-entry
store evicts in-flight records as well as completed ones. Restart or enough
other commands can thus turn an already accepted/in-flight mutation into a
fresh execution under the same key. A newly created session/provider run or
integration is not safe to repeat merely because the bookkeeping disappeared.
Desktop's S2 correction is conservative; mobile still uses this shared path.

Required fix: persist the pre-dispatch claim successfully before dispatch;
fail closed on damaged deduplication state; retain in-flight claims rather than
evicting them; and report an uncertain outcome instead of automatically
resubmitting on missing status. Explicit retries still require clear receipt
retention limits or durable operation-level idempotency. Test restart after a
failed claim write, corrupt restore, and receipt pressure while work is pending.

### S7 — Medium / P2: desktop fork result and child-stop receipt scope do not match the host

Snapshot: desktop `5ce1d560bd1503ae4ab8439ffa2c45f57e448a9a`.
Locations: `apps/desktop/src/renderer/src/features/machines/remote-client.ts:175`,
`apps/desktop/src/renderer/src/features/machines/RemoteSession.tsx:33`,
`apps/desktop/src/renderer/src/features/machines/RemoteSession.tsx:353`, and
`apps/desktop/src/main/remote-fork.ts:28`.

The host returns a fork's `result.sessionId`; the desktop validates `child.id`
and navigates with that absent field. A successful host fork becomes an
unresolvable saved receipt in the desktop. Separately, the parent view submits
`Stop agent` with the child's session ID under the parent's receipt scope, so
the new scope validator rejects it before IPC. Both failures are safe refusals,
but the dedicated remote workspace fails required allowlist behavior.

Required fix: use the actual remote fork result schema and scope child-stop
actions/receipts to their child session. Test the real wire shape, successful
receipt reconciliation/navigation, and stopping a child from its parent view.
Both findings were sent to the coordinator for desktop correction.

## Boundaries traced without a new finding

- Pairing approval is in-process on the host, never a remote approve route.
  P-256 nonce proof is single-use and invitation/device-bound. Matching
  confirmation codes remain required and invitation expiry is enforced.
- Tokens are short-lived, memory-only; public machine views and identity
  schemas omit private keys, bearer tokens and Connect leases. Production
  safeStorage registration rejects unavailable encryption and Linux basic_text.
- Gateway and WebSocket origin policies remain exact, including the selected
  HTTPS port. The private mobile computer switcher navigates to the destination
  origin rather than broadening CORS. Only the identity/public PWA navigation
  routes accept an absent Origin, and identity contains no user inventory.
- Production desktop destinations require Tailscale HTTPS names, exclusively
  tailnet DNS answers, pinned TCP lookup, valid TLS, and no redirects. Serve
  configuration rejects Funnel/incompatible mappings, rechecks before writes,
  and preserves other mounts. These controls did not prevent S1's application
  identity confusion; independently paired origins do.
- Connect verifier checks ES256 signature, issuer/audience/computer/device/key
  fingerprint, time bounds and a maximum 120-second lease. Managed callers set
  allProjects=false and use only signed project IDs for commands, queries,
  receipts and streams. New host projects trigger current registration sync;
  a fresh broker lease is still required. Account/provider operations remain
  an intentional paired-user allowlist capability, independent of project IDs.
- Host file access uses the host session workspace, path/credential exclusions,
  symlink checks, resolved containment and opened-handle checks. Attachment
  staging/read grants bind device/session or derive from the authorized journal.
  Renderer drafts/receipts/events/files use machine+session scope; views unmount
  across machine switches. No remote path reaches local command.dispatch or
  filesystem RPC in the dedicated remote workspace. S7 concerns correct use of
  that scope, not a cross-machine read/write fallback.
- Core lifecycle fix `4b8206da` adds cancellation to delayed authorization,
  lease renewal, command reconciliation and subscription cleanup. Mobile
  adopts disposal on origin change and guards delayed pairing writes. These
  are reviewed source corrections; authored worker test claims are separate
  from the reviewer's independent reproduction.

## Verification and outstanding work

Initial findings are based on source/control-flow inspection. Focused isolated
reproduction is pending; no broad build or test claim is made. All validation
must run through `scripts/coordination/run-heavy.mjs` with the shared lease and
resource gates, after a WIP commit. Final integrated snapshot, exact fix review,
complete branch coverage, and hardware/managed-service checks remain pending.
