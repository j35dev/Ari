# Machines T3 parity independent security review

Status: authored-source audit in progress; no integrated certification.
Reviewer: fresh Ari review session, codex / gpt-6.1-sol, xhigh effort, full permissions.
Date: 2026-11-12. Review worktree: `D:/Projects/Ari-machines-wt/security`, branch
`machines/security-review`. Existing untracked `.review-temp/` is preserved.

## Pinned scope

| Role | Immutable commit |
| --- | --- |
| Current integration | `2c75d8fb75300f3760243d5a9a29fa99236d55a2` |
| Routes author | `379ef67b3a3a14877cea2ac39cffc0633bebf6f1` |
| Host author | `4f7125e45b2096c5b2c1647ed744ff06aa2d92f8` |
| Session author | `869d3bc88a342844aa2fcf647a64ba859c6ffb67` |
| Shell author | `eac1173b83629672c0d6e870cccd9c75745b818f` |

Read controlling brief `machines-t3-parity.md`, integration `docs/design/machines.md`,
`docs/research/machines-parity-contracts.md`, and prior
`docs/research/machines-security-review.md` S1-S9 and limitations. Historical source
closure and tests in that report apply to its named snapshots only. These authored
heads have different merge histories; a branch comparison is not an integrated result.

Source review reads immutable Git objects. Only review/evidence documents are edited.
No runtime code, user checkout, installed/live Ari, real profile/settings, Serve mapping,
push or PR is touched. No additional workers are launched. Heavy verification, if
needed, will follow a committed WIP checkpoint and the shared below-normal resource
runner using D: fixtures, one worker, C >= 5 GiB and headroom >= 1.5 GiB gates.

## Disposition

Pending source audit of route authority/credentials, replay, grants, normal SessionClient
ownership, Auto/drafts, host sanitization, backward compatibility and F invariants.
The coordinator must supply the final integrated SHA before the final merged audit.
Source closure, authored regression assertions, independent executed proof and
real-hardware checks will be recorded separately.

## Authored-source checkpoint 2

The fresh audit repinned the authored heads to routes
`494566a5cf957c52c1a2b386c5e62034eaaa40c1`, host
`ae024ae1e83034eed7427f316207bb5497889d2a`, session
`114f1eb966bed772019e3849c340f54ebca9e6d9`, shell
`9af789fbf72b634d129ee4c400fd5b52f988af62`. Coordinator supplied intermediate
integration `77c07e60adba4157ebfac9f700e410c7661831b5`; this is explicitly **not**
the final integrated target. Later host `41307f0`, session `47d32aba` and shell
`f5ab05fa` are follow-up source, not part of a certification.

Source boundaries traced:

- `GatewayClient.#post` omits credentials on descriptor/proof/challenge/authorize
  calls even when its current token is set. `verifyRoute` verifies a fresh nonce,
  signature, pinned host ID/key, expiry and exact origin before `authorizeRoute`
  sends a device ID/signature. No public-ID equality supplies authority. Candidate
  wrong-key version claims continue fallback; a signed pinned mismatch stops it.
- Route tokens are short-lived and audience-specific; the original legacy bearer
  is not reused at a new origin. Pairing challenges consume nonces before proof
  validation and bind the device/audience/signing text. Revocation drops every
  token for that device. Managed Connect omits route authority and intersects its
  signed project lease, clears allProjects and retains terminal lease expiry.
- The sealed signing identity has flushed create-if-absent publication and an
  established anchor; missing/corrupt/mismatched sealed keys and unavailable OS
  storage fail closed. Production rejects Linux basic_text. This is source
  inspection, not an OS keyring or power-loss test.
- Registry IDs, credential origin/slot and pin persist when an original manual
  route is removed. Learned entries are nonremovable by the route UI and complete
  reports remove omitted learned entries while preserving manual ones.
- Host queries require authorization; catalog projects are grant-filtered and
  repository metadata omits raw URLs/userinfo. Resource sampling is demand-based
  with bounded CPU/memory validation. Host desktop creation resolves opaque
  device/project/root/expiry-bound workspace tokens and validates offered models
  and efforts. Approvals forward an exact host option ID.
- `SessionClient` carries immutable registry-machine/wire-session tuples,
  allowlists mappings and rejects a client project root or unsupported method.
  Watched transcript/history and attachment caches have machine invalidators;
  revocation advances an epoch and remounts normal SessionView state. Terminal
  tabs bind a distinct owner and host PTY ID, check the current terminal grant,
  serialize input, and retain unknown receipts without resend.
- Auto defaults off, filters Manual only at selection, requires connected
  compatible authorized inventory and resource age <=30s, CPU <85%, free memory
  >=1.5GiB and >=10% of total. A resolved draft is stable; Send/stage/prompt
  revalidate that host and do not pick a substitute or silently queue. Project
  selection creates client draft state; local and remote durable creation occur
  on first Send. The first effect has a saved attempt/receipt before dispatch.
- Intermediate gateway command delivery uses `conflict` after accepted execution
  loses authorization; it preserves original receipts. Missing, expired,
  internal-error, in-flight and malformed-result reconciliation remains read-only.
  Desktop replay uses bounded strict journal chunks, backpressure, gap/corruption
  diagnostics, subscribed-before-barrier live buffering and explicit terminal
  outcome. The newer session follow-up additionally validates complete replay
  sequence coverage. Legacy operation enum and old mobile wire remain unchanged;
  extension descriptors are omitted when no extension exists.

Potential source gaps requiring focused reproduction/final disposition:

1. Signed route manifests have issuedAt/expiry but no revision or rejection of an
   older report relative to the last accepted manifest. `verifyHostManifest` checks
   wall-clock freshness only and `MachinesRegistry.learn` can replace a newer
   complete report with an older still-valid report, restoring disappeared learned
   entries. This does not bypass fresh route proof or disclose a bearer by itself.
2. `MachinesService.#walk` retains a route-list snapshot and its asynchronous
   `#createConnection`/publication checks only machine existence. Unlike move-back,
   it does not consistently check current route membership after a route removal.
   Removal also cannot cancel DNS/proof work before the connection is registered
   in the pending set. Need a deterministic delayed-removal proof.
3. `loadMachineIdentity` is still exists/read or temp-write/rename without fsync,
   create-if-absent winner or recovery anchor. Desktop startup has Electron's
   single-instance lock; no headless runtime is shipped. Concurrent profile
   ownership and retained identity recovery remain necessary before headless.

Production exposure follow-up was inspected at host `41307f0`: `rpc.ts` supplies
routeSigning only from `origins.state()` with serving=true, owned=true and an
exact state.origin, never allowedOrigins/Host/forwarded/request fields. It also
makes localSnapshot resource sampling explicit. Final review must trace that
state back to the verified mapping and current listener target, not just its DTO.

Exact authored blobs for this checkpoint:

| Source | Commit | Blob |
| --- | --- | --- |
| main/machines.ts | 494566a5 | f244bdf3cae985aebfe79f204adb2d2a903aa5ee |
| main/machines-registry.ts | 494566a5 | 9d8adbbf6a13bbb44757c74df4220edaf7ab2b65 |
| remote-client/route-auth.ts | 494566a5 | b16da24f68d63a3ba963ee8f0483c3dbfe8cf904 |
| main/remote-host-metadata.ts | ae024ae1 | 6c716759922b452b8afefdd51e070ec3a751fb1b |
| remote-gateway/gateway.ts | ae024ae1 | 4d91617cb44bf5ecc34563df99683dfcc4c7b306 |
| renderer/session/session-client.tsx | 114f1eb9 | 5a41ea586834a6019f09d2938b426aded7017b3c |
| renderer/machines/machine-policy.ts | 9af789fb | 13551e46880ba429c597640497b2800bcc233462 |
| main/machine-identity.ts | 77c07e60 | d04337ebe83d142b610e57af22edca25c70b58ed |

No new execution tests, build, install, screenshot, live app or real hardware
checks were performed for this source checkpoint. Author route claims (36
Machines tests, 224 contracts, 24 client, 182 gateway) and host replay assertions
were read but are not independent reviewer execution or final integrated proof.
F orchestration branch ownership, physical overlap, managed cleanup and managed
terminal implementations remain byte-identical to the previously reviewed
snapshot; session-create adds only trusted host snapshot selection forwarding.
Existing `.review-temp/reproduce-takeover.mjs` is preserved unchanged.

## Independent route proof: open findings T1 and T2

Execution evidence: `evidence/machines-t3-security/route-result.json`; reproducible
source and fixture limits: `evidence/machines-t3-security/proof.md`. WIP was
committed before the below-normal, one-worker run. Corrected run exited 0 on
routes `494566a5`; it reproduces the gaps rather than claiming closure. The
first harness attempt stopped before assertions because this worktree has no
Zod install; the correction reads existing D integration dependencies only.

### T1 — Medium / P2: older signed manifests restore disappeared learned routes

Source: routes `494566a5`, `packages/remote-client/src/route-auth.ts`
`verifyHostManifest` (blob `b16da24f68d63a3ba963ee8f0483c3dbfe8cf904`) and
`apps/desktop/src/main/machines-registry.ts` `learn` (blob
`9d8adbbf6a13bbb44757c74df4220edaf7ab2b65`). Same source is retained at the
intermediate integration `77c07e60`.

Proof signs an older complete report [A,B], then a newer complete report [A].
After accepting [A], B is absent; accepting the older still-valid signed report
restores B as learned. The verifier checks freshness/signature/audience/pin but
has no revision/high-water comparison, and learn unconditionally replaces the
saved manifest. This breaks the accepted monotonic learned-route lifetime
contract. A copied ID/key cannot exploit it by itself: every destination still
needs a fresh pinned proof before credentials, and device revocation remains
effective. No credential-exfiltration or authorization-widening claim is made.

Required source closure: persist a monotonic authenticated manifest revision or
equivalent ordering, reject stale reports before any route/pin mutation, define
restart/clock-rollback semantics, and regress newer removal followed by old
report and overlapping refresh completion. A valid report may preserve the
original credential slot without restoring removed route entries.

### T2 — Medium / P2: a removed pending route can still receive device proof

Source: routes `494566a5`, `apps/desktop/src/main/machines.ts` `#walk`,
`#createConnection`, `removeRoute`, blob
`f244bdf3cae985aebfe79f204adb2d2a903aa5ee`; retained at `77c07e60`.

Proof starts connect using [A,B], delays A's network client-options work, removes
manual A while that work is pending, then releases it. The old walk sends a
device authorization proof to A and publishes connected A while the saved
route list contains only B. A later authenticated manifest can legitimately
relearn A if still reported; that separate behavior does not authorize the
already-removed pending connection before fresh learning. The signed pinned
identity remains required, so this is a lifecycle/selection violation, not a
copied-ID credential leak. Existing removal only aborts connections already in
the pending set; the asynchronous network/proof window precedes that insertion.

Required source closure: route-list/lifecycle generation or current membership
checks before network/proof, device authority and publication, with cancellation
of pending setup that has not installed a Connection object. Keep credential
slots independent from route membership. Regress delayed setup, removed later
snapshot routes and late move-back/manifest results without weakening key proof.

Additional replay concern is source-only until its independent fixture runs:
session `47d32aba`, `session-client.tsx` blob
`abcdc6887798e68f14b914190fbc02362eba0949` rejects every second start frame,
including a valid resume after a complete replay. Routes `#resumeSubscriptions`
forwards the new start into the same renderer handler on move-back/fallback;
RemoteSession renewal also reconnects its stream. The saved started flag is not
reset by terminal. The separate replay proof checks 2,100 rows, a valid resume,
continued live rows and epoch fencing using actual SessionClient/contracts.

No final integrated certification is issued. T1/T2 are open at the named source
and their independent reproductions; the coordinator has been notified.

## Independent replay proof: T3 confirmed, authored fix awaiting closure run

### T3 — Medium / P2: normal SessionClient rejects a valid reconnect replay

Source: session `47d32aba0a705b9738fcbafcb9c8f62585df2f0a`,
`apps/desktop/src/renderer/src/features/session/session-client.tsx`, blob
`abcdc6887798e68f14b914190fbc02362eba0949`. The subscription's `started` flag
survives a complete terminal, so a second valid start invokes incomplete and
permanently drops later frames. `MachinesService.#resumeSubscriptions` deliberately
retains the renderer callback across fallback/move-back, and RemoteSession uses
the same callback on its 45-second route-token stream renewal. Ordinary reconnect
therefore breaks the normal session transcript, independently of authorization.

Executed proof: `evidence/machines-t3-security/replay-result.json`; exact harness:
`evidence/machines-t3-security/replay-proof.md`. The shared runner exited 0,
below-normal, one worker after waiting for its lease. It delivered seq 0 and
2,100 initial rows with complete outcome, then rejected an exact-cursor resume,
dropped resumed seq 2100 and live seq 2101. Epoch advancement continued to fence
late frames. This is actual SessionClient/contracts execution with fixture IPC,
not a two-engine or React DOM proof.

Authored session fix `1c7cc31974feee4e6befd3f05707a4553210b4c3` resets `started`
on terminal, tracks the cursor and requires exact-cursor resumed starts; overlapping
starts still fail. SessionView now receives a replayStart marker to begin a new
history fold. Read this at intermediate `c395fad9da11eac6368ad0c022ab4965e2dea2ac`.
This is a source-closure candidate only until the final integrated target and
independent closure execution.

## Follow-up source checkpoint 3

Routes `5fe6f67f362caf5ee883f7be036acc98f23f7a31` adds durable report ordering in
MachinesRegistry.learn. It compares against the current saved report, ignores
lower issuedAt values, and intersects equal-time reports with the saved accepted
origin set. The latter set is persisted and validated across registry reloads;
an equal-time wider signed report cannot undo removal. This is a source-closure
candidate for T1. It does not introduce a host revision: clock rollback can delay
new reports until the saved timestamp is exceeded. That fails closed for route
learning but needs a documented operational/recovery policy and a reload/equal-time
regression. A silently ignored stale report is a valid rejection for this check;
the closure harness must check durable nonmutation rather than require an exception.

T2 remains unchanged in `c395fad9` and routes `5fe6f67f`: asynchronous route setup
precedes pending registration, and the walk checks machine existence without
current route membership before authority/publication. No tested/source closure
is recorded for T2 at this checkpoint.

The `77c07e60..c395fad9` production changes were audited: owned Serve state supplies
routeSigning, localSnapshot samples resources only on explicit demand, Auto
samples eligible hosts at selection and the original chosen host before first Send,
and the Composer uses the owning SessionClient for paste staging. Remote file
references require a matching session view key; OS nonimage paths are refused,
image bytes remain staged through the selected host, and local speech services
are absent from remote/unresolved drafts. Model/effort/mode controls use host
catalogs and finite command mappings. These observations are source review,
not independent UI execution.

At `c395fad9`, mobile, Tailscale Serve and RemoteTerminals are byte-identical to
prior reviewed `3f55df73` (empty source diffs). Strict journal replay now uses a
64 KiB FileHandle read buffer with the same 128-row/256 KiB chunks, strict UTF-8,
segment/line/tail diagnostics and guaranteed handle close. The new headless
design explicitly ships no executable/service, defines profile locks and sealed
OS identities, denies transitive/reverse grants, and defers update execution to
a separate approved launcher transaction. No runtime-host certification is claimed.

Final integrated SHA, independent fix reruns, combined two-engine signed route
fallback/move-back plus normal SessionClient proof, and real-hardware gates
remain outstanding. Existing untracked `.review-temp/` is preserved.

## Route correction source checkpoint 4

Routes `439fd021838b9739c9c7a44d6d13b2651ddb4be5` was independently inspected.
MachinesService blob `f12b34a18848743326aa77b3bf14cd7251c611f1` introduces a
PendingRouteAttempt before asynchronous setup, an AbortController shared with
the connection, and per-machine/origin generations. Membership changes after
durable registry updates abort both pre-Connection and installed candidates.
The same origin removed and re-added receives another generation; old work
cannot publish. Signal checks follow DNS, candidate proof, identity, credential
load and per-origin authorization, and generation/current membership checks
fence negotiation, active-result adoption and walk publication. Existing
authorizeRoute signal checks prevent an in-flight challenge reply from triggering
the later device signature/authorize request. Reordering preserves unchanged
membership rather than canceling a healthy connection. Manifest-driven learned
removal uses the same fencing, while credential slots remain independent.

Registry blob `093f6a3d56bfb87e2ea28c54f414fc487b275b37` retains T1's durable
high-water and equal-time intersection and filters learned membership through
the accepted transport-eligible routes. Added authored tests cover stale report
replay across restart with byte-for-byte durable nonmutation, both equal-time
completion orders with intervening reloads, manual-route/credential preservation,
delayed DNS removal, removal/re-addition and delayed signed proof/challenge replies.
These are source-reviewed regression assertions; no reviewer run of that suite
or independent final integrated closure is claimed yet.

The independent closure harness preparation is recorded in
`evidence/machines-t3-security/closure-proof.md`. It preserves the historical
reproduction and checks durable no-op rejection, equal-time narrowing after
reload, credential-slot preservation and the original pending-DNS reproduction.
T1/T2 now have source-closure candidates at this authored SHA; final merge and
independent executed closure remain required.

## Independent integrated-snapshot route closure

Ran the prepared route fixture with `fixed` on integrated
`dbbe9f6d0de3dddcb016e7b8f371d1c2b02b53d9`; this is the current merged source,
not yet a parent-designated final target. Evidence is
`evidence/machines-t3-security/route-closure-result.json`. The shared runner
exited 0 with one below-normal worker, no signal. T1's old report leaves durable
state byte-identical after reload, learned B remains absent, and equal-time wider
reports cannot restore B after another reload. T2's delayed setup produces no
device authorization proof or connected publication at the removed A; the walk
continues successfully. Original credential slot/cipher and pin survive removal.
Audience-specific tokens, consumed challenges, device withdrawal, no reciprocal
device, unowned audience denial and candidate proof before credentials all pass.

T1/T2 have independently tested closure at this exact snapshot and the named
blobs (`f12b34a18848743326aa77b3bf14cd7251c611f1`,
`093f6a3d56bfb87e2ea28c54f414fc487b275b37`). This fixture does not establish real
DNS/TCP/TLS/Serve/OS keyring behavior or the combined two-engine route/SessionClient
flow. Final-target source comparison and replay closure remain pending.

## Independent integrated-snapshot replay closure

Ran the unchanged replay reproduction with `fixed` on the same integrated
`dbbe9f6d0de3dddcb016e7b8f371d1c2b02b53d9`, SessionClient blob
`548933015c1804e8b35eac68d6c87fc7a4860f07`.
`evidence/machines-t3-security/replay-closure-result.json` records the exact
command, one-worker below-normal resource gate and exit 0/no signal. It delivered
seq 0 and all 2,100 initial rows, admitted the exact-cursor resumed row, delivered
the following live event, and rejected late frames after the authorization epoch
advanced. T3 has independently tested closure for this reproduction at this
merged snapshot. Its fixture boundary remains explicit: actual SessionClient
and contracts, fixture IPC/inventory; no DOM or combined host/route proof.

No additional runtime source changed. The host follow-up `f8c5217c` was inspected:
bounded replay/file/metadata contracts retain the reviewed behavior, the main
SCM dependency uses typed SourceControlHost reads with exact session IDs instead
of generic RPC registry casts, and the broader changes format the same adapters.
New authored real-two-engine replay/ownership/restart, slow-consumer cancellation,
live-buffer overflow, revocation and invalid post-effect result tests are useful
source evidence; their separate execution claims require the coordinator's final
test output. Their two-engine test uses direct legacy tokens, not signed ordered
route fallback/move-back through normal SessionClient. The combined parity proof
gap therefore remains.

T1/T2/T3 are independently closed at the named merged source. A parent-designated
final integrated SHA must still be compared for merge changes before final
disposition; hardware and combined-route proof gates are not waived.

## Parent-supplied source checkpoint 5: `7b11fd89`

Parent supplied current integration `7b11fd8913e12ac04ff123f2afe89c3eeedf2bf5`,
explicitly withholding final certification until the combined loopback proof and
designated final runtime SHA. The independently executed T1/T2/T3 source blobs
are unchanged from `dbbe9f6d`: MachinesService
`f12b34a18848743326aa77b3bf14cd7251c611f1`, MachinesRegistry
`093f6a3d56bfb87e2ea28c54f414fc487b275b37`, SessionClient
`548933015c1804e8b35eac68d6c87fc7a4860f07`. There is no reason to repeat these
same focused executions solely for a different merge SHA; the final comparison
will verify whether their source/dependencies changed.

Independently audited the host rename delta `c2b1266e` / integrated `1652cd6b`
and fixture isolation `c8a817c0` / `289af47d`. Final-at-this-checkpoint RemoteHost
blob is `e11780109b24d47410b6b944a78464b5d404d04a`. SCM status now requires
safeSnapshotPath for both the current path and an optional oldPath. Previously
a renamed sensitive source could leave its private name in the status DTO even
when the new path was ordinary; the change brings status in line with the
review/turn-diff filters. The authored regression uses a real Git .env->safe.txt
rename and SourceControlHost, proves local status contains oldPath, then checks
the authenticated remote DTO has no files, .env name or host root. The isolated
repository change avoids journal artifacts affecting its assertion. This is
source-reviewed closure of the host owner's hardening, not an independently
executed rename regression claim.

Shell `4881bc8c` adds remote owner/status chrome from the existing immutable
SessionScope registry ID and shows missing remote inventory as remote/offline.
It changes display and fixture capture, never reconstructs a local session ID
or changes authorization. Sidebar host-label layout and capture-script changes
do not change dispatch. The isolated dev launcher and run-heavy D-cache temp
override are coordination-only; no runtime service/update feature was introduced.
The override validates a resolved absolute descendant of D:/Projects/.ari-cache
and leaves heavy resource floors/priority intact. Reviewer does not run the dev
launcher. F managed-workspace/orchestration/physical ownership implementations,
Tailscale, RemoteTerminals and mobile remain byte-identical to `3f55df73`.

The host owner is authoring the combined actual-two-engine, signed-two-listener,
MachinesService->IPC bridge->normal SessionClient regression. Its final source,
exact executed result and final runtime designation have not arrived yet.

### Remaining limits and hardware gates

- Machine identity publication remains the prior `loadMachineIdentity` temp
  write/rename implementation, blob `d04337ebe83d142b610e57af22edca25c70b58ed` at
  this source. It has no fsync/create-if-absent retained recovery winner. Desktop
  single-instance ownership and sealed host-signing mismatch failure contain the
  security boundary; abrupt power loss/concurrent profile ownership recovery is
  an outstanding identity-parity limitation. No shipped headless runtime is claimed.
- Durable issuedAt ordering denies rollback of learned routes; a backwards host
  clock can delay accepting new reports. Recovery must preserve the saved pin,
  original credential slot and route high-water rather than silently resetting them.
- Two real desktops on one tailnet: actual HTTPS/DNS/TCP destinations, independent
  approvals in both directions, fallback/move-back/cooldown, grant withdrawal,
  sleep/wake/network/ACL changes and retained host identities.
- iPhone Safari/installed PWA: non-443 HTTPS, pairing/reconnect/storage, sleep and
  network/ACL changes; mobile behavior remains unchanged at the source level.
- Windows DPAPI/Electron safeStorage, macOS Keychain and Linux Secret Service:
  real restart/unavailable-keyring behavior and platform filesystem durability.
- Real PTY/provider descendant cleanup: device/terminal withdrawal, signed lease
  expiry, host shutdown, sleep/wake, and F branch/worktree containment.
- Private Connect broker/tunnel registration and renewal/revocation with signed
  project scope/expiry. Fixture/public-loopback tests cannot verify private services.
- Headless OS services, management-pipe/socket permissions, cross-runtime profile
  locking and launcher updater trial/rollback require separate runtime review if
  implemented. All remain deferred design at this checkpoint.

No final integrated certification is issued. Review-only documents/evidence are
committed; original and new untracked .review-temp evidence is retained.
