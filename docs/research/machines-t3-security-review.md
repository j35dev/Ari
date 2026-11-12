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
