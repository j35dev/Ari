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
reviewer's isolated P-256 challenge-relay reproduction passed through the
shared validation runner against both immutable commits (evidence below).

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

Grants correction `52f98b3a054253d44fbc652e997fb6a4aefe6880` serializes starts
and stops, deduplicates pending starts, fences both listener publication points
with generations, and closes a listener created after cancellation. Source and
the authored delayed-project/listen/managed-start tests were reviewed. Final
integration and worker execution evidence remain pending.

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

Grants correction `52f98b3a054253d44fbc652e997fb6a4aefe6880` adds verified
`managedLeaseExpiresAt` to the caller and PTY entry, renews only through a live
verified managed call, rejects cross-mode access, kills expired entries, and
closes managed shells when the managed listener stops. Source and authored
expiry/renewal/no-resurrection/private-shell tests were reviewed. The watchdog
has up to one second of expiry/grant-withdrawal latency; this is not a claim
that all detached OS descendants are terminated on real hardware.

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
than reporting durable success. Keep runtime denial in effect and explain that
the security change could not be saved; do not certify restart revocation until
it is durable. Cover injected filesystem
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

## Bounded receipt policy recommended to the coordinator

For v1 compatibility, missing `command.status` should answer `conflict` with
"Outcome unknown: no retained receipt; inspect host before submitting again."
The old shared client's `not_found` automatic reconciliation path then stops.
New clients must retain the exact command and key on absence. Pin in-flight
claims and reject fresh admissions when the bounded store is full of pinned
work. Completed payloads may be bounded; compact fingerprint/key tombstones
should refuse forgotten replay within an explicitly documented horizon.
Corrupt state must not create a fresh empty deduplication history.

Recovery should offer host inspection and abandonment of the local receipt.
Any deliberate resubmission after retention loss must warn that it may
duplicate work, with an explicit confirmation. Unknown terminal input should
never be replayed automatically.

Compatibility limit: a cached old UI can send its old UUID directly to
`/command` before checking status. After all evidence of that UUID is evicted,
a bounded v1 server cannot distinguish it from a genuinely new key. Changing
the status failure stops legacy automatic reconciliation but does not solve
this direct replay. A hard guarantee needs a new negotiated mutation capability
that refuses old clients and server-issued expiring reservations or signed
epoch-bound keys, rather than an unlimited journal. The coordinator has this
explicit contract/retention limitation; arbitrary-old exactly-once behavior
must not be claimed for the current protocol.

## Independent reproduction and verification

Command (after report WIP commit `d26f529f`):

```text
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs security D:/Projects/Ari-machines-wt/security -- node D:/Projects/Ari-machines-wt/security/.review-temp/reproduce.cjs
```

The runner serialized the single process behind the swarm lease, applied the
C >= 5 GiB / commit-headroom >= 1.5 GiB gates and below-normal priority, and
used D: temporary/cache paths. No dependencies were installed. The temporary
fixture loaded the actual MachinesService, registry, shared session, schemas
and PairingService from immutable Git snapshots through the already installed
TypeScript transpiler. Its transport adapter relayed challenge/authorize calls
to the real PairingService and used actual P-256 signatures and AES-GCM sealed
per-machine credentials in a security-worktree-only profile. This is a focused
application-trust/crypto reproduction, not real-Tailscale or two-engine proof.

| Snapshot | Host approvals | Proofs relayed to attacker | Valid host token obtained |
| --- | ---: | ---: | --- |
| vulnerable core `7119a5a` | 1 | 1 | yes |
| fixed core `02158cd` | 1 | 0 | no |

Assertions additionally verified that the vulnerable record inherited the
original machine scope; fixed records have distinct local IDs and a null
attacker credential; and the fixed original goes offline when unreachable
rather than authenticating through the attacker. Fixture completion was
`success:true`. No private key, signature, nonce, or bearer value appears in
the evidence/report. Temporary reproduction files are removed after recording
the result; only this report is committed.

Source inspection covered the public identity/version/capability boundary,
pairing and grants, signed Connect project intersection, origin/DNS/Serve
policies, IPC secret exposure, terminal ownership/expiry, host file/attachment
checks, renderer machine/session state, mutation receipts and lifecycle races.
Authored worker tests were read where noted; the reviewer did not rerun their
suites or wide builds. Current S1–S4 source corrections require final integrated
snapshot confirmation. S5/S6 persistence and retention corrections and S7 wire
corrections remain outstanding at this report commit.

Required hardware/service gates remain unverified here: two computers on one
tailnet, iPhone/PWA on the selected non-443 origin, sleep/wake/network/ACL
changes, terminal withdrawal against real PTYs, safeStorage across desktop
restarts, and the private managed broker/tunnel lease-refresh behavior. The
private broker must accept updated registered IDs while keeping its own
account/project restrictions; this repository does not deploy or verify it.

## Fresh takeover audit, 2026-11-12

Reviewer remains report-only in `D:/Projects/Ari-machines-wt/security`, using
codex / gpt-6.1-sol, high effort, full permissions. The coordinator's current
two-slot resource runner supersedes the old single-slot documentation. F must
now integrate into `feat/machines` while retaining its independent main-based
branch. No worker code, live accounts, settings, devices or Serve mappings are
changed by this review.

Immutable authored snapshots read during takeover:

| Stream | Commit |
| --- | --- |
| Core | `8471f3f30d5ab01779ce15272fc5951d5e14a4fe` |
| Desktop | `92d29b6bf69d13f899c58ed7189f1a5c3790baa8` |
| Mobile | `bd1821684cedb7cdba9b4715d3c95b2e5513d375` |
| Grants WIP | `63b602af33b1fa7f34bc7e57708fec2ce945763b` |
| Parallel roots F | `89b22dbd10e22854e20c253629c291b148a2bfaa` |
| Coordinator before final integration | `2afa3454eecd1a5ecac087650d9a23479ebf0a72` |

S1-S4 corrections remain present in authored source. S7 is corrected by
`08415210`: fork validates and opens `sessionId`; child actions retain their
own session receipts and provide navigation for reconciliation. Core's
`23ba62d1` and mobile's equivalent now make lost-response reconciliation
read-only, retain the original key on absence, and accept only an authoritative
success envelope. Grants WIP pins in-flight claims, refuses fresh admission
when all capacity is pinned, rejects corrupt restore, and returns an uncertain
`conflict` for absent status. This is partial S6 closure only.

S5 remains open at the recorded grants WIP: `RemoteService.#write` still logs
and swallows writes, `#read` collapses every read failure into absence, and
the new `PairingService.suspendAuthorization` is not yet wired to the writer.
The parent confirmed the grants worker owns throwing writes, latched runtime
denial, strict reads, blocked damaged restore and restart regressions.

Two further authored risks are assigned by the parent and require review at
their corrected snapshots: mobile retry controls still call `send` for saved
prompt/create/fork/integration receipts, and legacy unscoped phone-key migration
uses mutable `ari.remote.origin` as ownership evidence. The agreed legacy-key
policy preserves the unscoped database and requires fresh per-origin pairing.
Neither a missing receipt nor a mutable address proves the needed trust binding.

F source review traced actual physical folder resolution, cross-root admission,
parked-turn reauthorization, uncertain-root recovery and owned cleanup. The
uncertain-root path consults only the caller's durable launch receipt and
rechecks its current archive/permission cap before destruction. Cleanup derives
paths from the validated session ID below the managed root, resolves containment,
and detaches links before recursive deletion. Focused adversarial reproductions
and exact results will be appended after the required WIP commit. Final
integrated SHA review and certification remain pending.

### S8 — Medium / P2: root branch cleanup authorizes a foreign branch by a timestamp prefix

Snapshot: F `89b22dbd10e22854e20c253629c291b148a2bfaa`.
Locations: `packages/engine/src/git/orchestration-branch.ts:2`,
`packages/engine/src/git/managed-workspaces.ts:450`, and
`apps/desktop/src/main/session-create.ts:23`.

Human root IDs use `sess_<timestamp in base36>_<random suffix>`. The branch
ownership helper drops the random suffix and uses the first eight timestamp
characters. Different roots can therefore share cleanup authority. Destroying
one root scans every `ari/` branch and selects another root's matching branch;
Git protects currently checked-out branches, but a retained unregistered branch
can be deleted, losing the reference to unintegrated work.

Independent reproduction used actual immutable `ManagedWorkspaces.release`,
branch helpers and physical folder comparison, with a fake Git adapter and a
temporary profile. `sess_mabcd123a_aaaaaa` and `sess_mabcd123a_bbbbbb` produce
`ari/one-mabcd123` and `ari/two-mabcd123`. Releasing the first emits `branch -D`
for both. An unrelated branch is not selected; the sibling directory and an
external junction's target remain intact. This proves erroneous deletion
authorization, without deleting real Git work or interacting with live Ari.

The parent assigned correction immediately. F `77f9422de5840072351295fcd8042fdb5e807a80`
uses `s_` plus the full SHA-256 of the exact ID. Ambiguous legacy short-key
branches are retained; an older exact full-ID suffix still authorizes only its
owner. Source and the authored real-Git unregistered-branch regression were
reviewed. Independent corrected-snapshot reproduction and final integration
remain pending.

### Additional takeover corrections and remaining receipt review

Grants `f2319167` / `21e6e091cb199cacd76216ef518593f554ea61be` now propagate
record write failures, latch runtime denial, reject non-ENOENT read failures,
and block listener publication over damaged device/history records. Pairing
blocks old tokens and new authorization after a failed save. The terminal
watchdog consults that denial, and managed shutdown awaits PTY cleanup.
Authored injected-write/read/corrupt-restore, explicit-retry/restart and
terminal-withdrawal tests were inspected. A failed withdrawal does not become
durable merely because runtime access is blocked: the error explicitly warns
that previously saved access may return after restart; storage must be repaired
and the withdrawal successfully saved before restarting. Final execution
evidence and integrated verification remain pending.

The same grants snapshot removes legacy unbound-key migration. Core
`a5600bf8` publishes generated keys and device IDs only after sealing and
registry persistence succeed; `870022b0` renegotiates before token-refresh
command retries and clears stale tokens/capabilities/terminal grants. F
`a26861db` preserves the complete uncertain workspace identity for
`projects.ask` as well as `session.spawn`. These are source-reviewed corrections.

S6 remains open in desktop `be958760afdf38b642923efef05dcfdfcef1ec18` for
legacy-host status absence: `resolveReceipt(retry=true)` directly resends after
`not_found`, without explaining duplication uncertainty. The parent assigned
removal of resend and read-only receipt controls. Mobile's component retries
also require their corrected snapshot. Separately, shared receipt lookup must
map nonauthoritative errors such as `access_revoked` and
`unsupported_capability` to an uncertain keyed failure, so component refusal
handling cannot clear an originally accepted receipt. The parent assigned that
correction to core. None of these named lookup failures proves nonexecution.

### Independent takeover verification

After WIP `e27ccf9b65180143a91487f6be315cd55a2f7525`, run through the current
coordinator runner:

```text
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs security-takeover D:/Projects/Ari-machines-wt/security -- node C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs exec node .review-temp/reproduce-takeover.mjs
```

The successful run used Node 24's built-in TypeScript transform to load actual
code from immutable Git objects; no dependencies were installed. Temporary
filesystem fixtures stayed under the security worktree and were removed with
resolved containment checks. The first attempt had a fixture-only method-name
error (`expire` instead of `prune`); the corrected run exited 0 with
`success:true`. No killed/OOM process or resource-gate failure occurred.

| S6 store snapshot | Pending claim under capacity pressure | Pending claim past TTL | Corrupt restore |
| --- | --- | --- | --- |
| `52f98b3a` | evicted | removed | silently empty |
| `63b602af` | retained; new admission refused | retained | rejected |

Physical-folder fixtures additionally verified junction aliases, nested
folders and Windows case identify overlapping workspaces; siblings do not.
These focused reproductions are independent review evidence, not the final
integrated suite, real-Git branch regression, hardware or managed-service proof.
