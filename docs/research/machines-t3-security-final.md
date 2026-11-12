# Machines T3 parity: final independent security review

Reviewer: fresh Ari security session, codex / gpt-6.1-sol, xhigh, full permissions.
Date: 2026-11-12. Review-only branch `machines/security-review` in
`D:/Projects/Ari-machines-wt/security`. Runtime source:
`8b2d0dcb14af5cc841f92fdf339388df4d026fbf`, superseding the parent's earlier
`afa7f96c4fa354334e22f0dfab0f8ae08912f824` designation.

Bounded final source certification issued for
`8b2d0dcb14af5cc841f92fdf339388df4d026fbf`, explicitly designated by the parent.
No unresolved actionable source finding remains in the reviewed runtime scope.
T1/T2/T3, the combined signed-route normal-client proof and identity recovery/key
continuity independently pass at the exact source checkpoints below. The final
cleanup delta also independently passes native-filesystem failure injection on
this exact final source. The parent's full integrated run continues and is not
certified by this report. Real-hardware/platform and private-service checks remain below.

The [checkpoint ledger](machines-t3-security-review.md) preserves historical
findings, source SHAs/blobs and reproduction/closure evidence. Controlling inputs
were the latest `machines-t3-parity.md` brief, `docs/design/machines.md`,
`machines-parity-contracts.md` and prior `machines-security-review.md` S1-S9.
Only review/evidence documents changed. No runtime edits, user checkout/build,
installed/live Ari/profile/settings/Serve changes, push, PR or new worker.
Original untracked `.review-temp/`, including `reproduce-takeover.mjs`, is preserved.

## Findings and closure

| Finding | Severity | Confirmed source and failing behavior | Final disposition |
| --- | --- | --- | --- |
| T1: stale signed manifest restores removed learned route | Medium / P2 | `494566a5`, registry blob `9d8adbbf6a13bbb44757c74df4220edaf7ab2b65`; older valid [A,B] report restores B after newer [A]. | Independently closed on `dbbe9f6d`; durable issuedAt high-water and equal-time intersection survive reload. Final registry blob unchanged. |
| T2: removed pending route still receives device proof and becomes effective | Medium / P2 | `494566a5`, MachinesService blob `f244bdf3cae985aebfe79f204adb2d2a903aa5ee`; delayed setup survives route removal before pending registration. | Independently closed on `dbbe9f6d`; early attempt registration, abort and per-origin generation fence DNS/proof/key/authorize/publication, including remove/re-add. Final service blob unchanged. |
| T3: second normal replay start is rejected after completed terminal | Medium / P2 | `47d32aba`, SessionClient blob `abcdc6887798e68f14b914190fbc02362eba0949`; resumed/live reconnect frames disappear. | Independently closed on `dbbe9f6d`; terminal releases replay-start state, exact cursor is retained and resumed start reopens the normal history barrier. Final client blob unchanged. |

The required stable machine-ID publication/recovery limitation was also closed
in source and independently tested at `c537a8e2`; final cleanup hardening is
source-reviewed and independently tested at `8b2d0dcb`. The host-owner sensitive rename hardening filters both
status path and oldPath. Its actual Git/SourceControlHost regression was
source-inspected; this reviewer did not separately execute that regression.
Prior S1-S9 source safeguards remain present in the inspected boundaries; their
historical tests are not presented as new reviewer executions.

## Independent executions

Every run used the shared `run-heavy.mjs`, committed WIP first, below-normal
priority, one reviewer worker and gated D: fixtures. Each evidence JSON retains
the exact command, source/blob, resource admission, exit code and result.

| Evidence | Immutable source | Actual result and scope |
| --- | --- | --- |
| [Route reproduction](evidence/machines-t3-security/route-result.json) | `494566a5cf957c52c1a2b386c5e62034eaaa40c1` | Confirmed T1/T2; original crypto/grant negatives passed. Reproduction success confirms the defects, not closure. |
| [Replay reproduction](evidence/machines-t3-security/replay-result.json) | `47d32aba0a705b9738fcbafcb9c8f62585df2f0a` | 2,100 initial rows complete, then valid resume/live dropped; epoch fence passed. |
| [Route closure](evidence/machines-t3-security/route-closure-result.json) | `dbbe9f6d0de3dddcb016e7b8f371d1c2b02b53d9` | Exit 0. Stale/equal-time removal survives reload, credential slot retained, no removed-route proof/publication; audience/single-use/revoke/no reverse/unowned exposure/proof-before-credentials passed. Actual source/crypto with deterministic transport and fixture AES-GCM. |
| [Replay closure](evidence/machines-t3-security/replay-closure-result.json) | `dbbe9f6d0de3dddcb016e7b8f371d1c2b02b53d9` | Exit 0. 2,100 initial rows complete including seq zero; exact-cursor resume/live delivered and epoch fenced. Actual SessionClient/contracts with fixture IPC/inventory/action transport. |
| [Combined normal-client proof](evidence/machines-t3-security/combined-result.json) | `1c2398a4177bdc97741bbbe0d8304f6640176d04` | Exit 0. Exact authored assertions through actual two Engines/stores, signed HTTP/WS, DNS/TCP, MachinesService/RPC/preload facade and normal SessionClient. 2,406 initial journal rows; full/resume/live, fallback/cooldown move-back, one B turn/A untouched, distinct route token, no reverse approval, redacted repo grouping, authenticated fixture Auto/Manual only, B-only revoke/cache purge. |
| [Identity recovery/key continuity](evidence/machines-t3-security/identity-result.json) | `c537a8e2a492f1c2dc92894cd009ff6b07e79598` | Exit 0. Real files and two independent processes each for fresh/legacy/missing-primary/empty-primary cases; stable separate recovery, invalid-file preservation, same legacy ID and sealed key/anchor bytes, missing signing key cannot reset. Fixture AES-GCM. |
| [Final identity cleanup](evidence/machines-t3-security/identity-cleanup-result.json) | `8b2d0dcb14af5cc841f92fdf339388df4d026fbf` | Exit 0. All prior identity/key/concurrent assertions pass again. Injected unlink failure retains a complete winner and two nonauthoritative unique temporaries; injected link plus unlink failure preserves original publication EACCES and leaves no primary/recovery. Native-fs injections restored in finally; fixture AES-GCM. |

The combined proof replaces Vitest assertion/spy helpers only and preserves the
authored source/assertions. Its first pre-assertion loader dependency failure is
[retained](evidence/machines-t3-security/combined-import-failure.json), with the
loader correction in [combined-proof.md](evidence/machines-t3-security/combined-proof.md).
It is not a whole Vitest-suite claim. Its preload/localStorage/provider/counters
and controlled HTTP reachability remain authored fixtures. No TLS/Tailscale,
React DOM, OS keyring/counters, real provider or incompatible installed binary
was tested by that proof.

Parent separately reports combined 1/1 and authored identity 10/10 passing. Its
earlier focused 73-test run had 72 pass and one default 1s pairing wait timeout;
`4a962569` extends only that fixture wait to 5s. Broader suites, typecheck, lint
and builds are parent-owned and continue. Worker handoff claims and authored
regression assertions are source evidence, not reviewer-executed broad checks.

## Source boundaries and final comparison

- A fresh signed descriptor/proof verifies pinned host key/ID, nonce, exact
  audience and expiry before any device ID/signature or credential is sent.
  Public-ID equality cannot merge authority. Tokens are origin-specific; a
  learned origin reuses approved device identity through its own proof exchange,
  never the original route bearer. HTTPS credentials cannot downgrade to HTTP.
  DNS/TCP pinning and redirect refusal remain production policy.
- Production routeSigning derives solely from serving, owned, exact Serve state
  traced to the verified mount targeting the current loopback gateway. It never
  derives audience from the Origin allowlist, Host or forwarded/request headers.
  Managed Connect has no such route authority; its signed project scope/expiry
  and terminal lease remain intersected. Missing/corrupt/unavailable sealed
  signing storage fails closed without plaintext/key/pin-reset fallback.
- Complete learned-route removal preserves manual routes and the original sealed
  credential slot. Per-origin generations fence removed/re-added pending work;
  stale signed reports are durable no-ops. Fallback/move-back/cooldown changes
  transport only. Only pinned authenticated incompatibility stops a route walk.
- Pairing stays one-way per direction and per device. Repository/group identity
  grants no reverse/transitive/peer authority. Machines is outgoing access;
  Mobile access remains incoming devices. Host agents/children gain no implicit
  target-machine connection or local fallback from a UI pairing.
- Authenticated demand-only aggregate resources use fresh Auto data; Auto is off
  by default, Manual only excludes automatic selection only. The resolved draft
  and workspace lock are stable, busy hosts do not silently queue or substitute,
  and durable local/remote draft creation occurs on first Send.
- Remote sessions use normal SessionClient with immutable machine/session tuples,
  finite mappings and no client-root authority. Revocation epochs purge watched
  state; split panes and terminal tabs retain their owners and current grant
  fences. Unknown receipts remain read-only and never automatically resend.
  Host catalogs, snapshots and attachment paths are sanitized, workspace options
  are host-issued and approvals forward the exact offered option ID.
- Desktop extensions are separately negotiated and omitted for legacy hosts;
  mobile operation vocabulary/results remain unchanged. Complete replay is
  chunked/bounded with backpressure, gap/incomplete diagnostics and runtime/live
  fences. Beyond the focused proofs, corruption/overflow/strict legacy omission
  and version mismatch regressions were source-reviewed, not independently run.
- Host updates remain manual. Headless host/services/updater/agent-peer execution
  are detailed deferred design, with no new executable runtime in this scope.

MachinesService/registry/network, remote-client/remote-gateway runtime and normal
SessionClient/access/history/transcript are byte-identical from independently
tested `dbbe9f6d` through this final source. The combined proof's later change is
formatting; metadata and path-regex lint changes preserve their exact expressions.
The identity delta after `c537a8e2` is formatting plus final temporary-cleanup
error handling. The sensitive oldPath filter and shell owner/offline display
deltas were independently inspected. Subsequent session commits add test/config/
handoff files only; the focused tsconfig extends, not replaces, the full config.
The final comparison to integration `703de3f902cb2e3d70a102b1a3411b89dc7106d5`
finds only the newer root-concurrency test fixture under runtime source directories,
with no runtime implementation change. Its offered-model/workspace-token assertion
additions are source evidence; no reviewer execution of that new test is claimed.

F managed-workspaces/orchestration/workspace, RemoteTerminals, Tailscale and mobile
have no changed source against prior final security baseline `3f55df73`. The
reviewer did not repeat identical F/runtime suites or claim new hardware closure.

Selected final source blobs at `8b2d0dcb`:

| Source | Blob |
| --- | --- |
| main/machines.ts | `f12b34a18848743326aa77b3bf14cd7251c611f1` |
| main/machines-registry.ts | `093f6a3d56bfb87e2ea28c54f414fc487b275b37` |
| main/machines-network.ts | `137f014e2eea13fa1d66144b94e562655560b9d1` |
| main/machine-identity.ts | `b884aff7ef9aa420ab0a28e3362fc0382e62a68c` |
| main/host-signing-identity.ts | `5dacb26cd96e2d6bfee3e35c1513774b7478e60f` |
| main/remote-host.ts | `e11780109b24d47410b6b944a78464b5d404d04a` |
| main/remote-host-metadata.ts | `f05d70cf418a79825a4dd4ceb547eff03a0ab632` |
| main/remote.ts | `629addd6c451d215792e7cc772a99c48534f2b04` |
| main/rpc.ts | `c393ca935848811548c91cc690f7a3a9e97c2737` |
| renderer/session/session-client.tsx | `548933015c1804e8b35eac68d6c87fc7a4860f07` |
| renderer/machines/machine-policy.ts | `f57f38cf0831e013ab27fb356c039be5dc77ed5e` |
| contracts/remote-desktop.ts | `c2064d449c46dbf9a177663f1a5c6f0120dfb7a9` |
| remote-client/gateway-client.ts | `57d26dfee52e8c7346fa04f7dead513ce4f849aa` |
| remote-client/route-auth.ts | `b16da24f68d63a3ba963ee8f0483c3dbfe8cf904` |
| remote-client/session.ts | `f932743a8dc297c983a1669a1d8c5272b70ab116` |
| remote-gateway/gateway.ts | `609b2e1654a4ce770e346ea4f53322975a5f2a4d` |
| remote-gateway/pairing.ts | `b12c4dbeaf9f558a46d537e9733b0720d784b218` |
| remote-gateway/idempotency.ts | `339c854bb29686c86e2f80777826e4568f981d23` |

## Remaining concrete limits and hardware checks

- Bounded v1 receipt retention cannot distinguish an arbitrarily old directly
  resent forgotten UUID from a new key. Unknown-status/read-only reconciliation
  prevents automatic resend; unlimited exactly-once is not claimed. Stronger
  direct-replay guarantees require a separately negotiated reservation/epoch design.
- Route report high-water ordering can defer new reports after a backwards host
  clock. Recovery must preserve pins, credential slot and high-water, not reset
  them to force success. Failed revocation persistence denies runtime authority
  but is not a claim that old disk bytes have been durably replaced.
- Windows files are flushed but Node exposes no directory fsync. Actual crash/
  power-loss recovery, filesystem hardlink support, deletion of both ID/anchor
  files, arbitrary external mutation and desktop/headless profile-owner locking
  remain outside this proof. A leftover unique public-ID temporary is never read
  as the primary/recovery authority. Headless profile sharing is not implemented.
- Real Windows DPAPI/Electron safeStorage, macOS Keychain and Linux Secret Service:
  restart/unavailable storage, retained identity/key/pin and durable withdrawal.
- Two real desktops on one tailnet: HTTPS DNS/TCP destinations and non-443 owned
  Serve, independent approvals in both directions, fallback/move-back/cooldown,
  sleep/wake/network/ACL changes and revocation. iPhone Safari/installed PWA:
  selected non-443 pairing/reconnect/storage and sleep/network/ACL behavior.
- Real providers and PTYs: device/terminal withdrawal, signed lease expiry, host
  shutdown and descendant cleanup with F branch/worktree containment. Actual
  split-pane/terminal DOM/native interaction is outside reviewer loopback proof.
- Private Connect registration, signed lease renewal and project refresh/revoke.
  Real incompatible binary negotiation and manual update UX also need hardware.
- Headless management socket/pipe permissions, OS services, cross-runtime profile
  locks and launcher update trial/rollback need separate runtime review if built.

These are bounded source/test conclusions at the named immutable runtime source.
Full root verification and the concrete platform/hardware checks are separate
completion gates, and later runtime changes require comparison against this review.
