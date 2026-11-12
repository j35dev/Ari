# Machines final delta: independent security equivalence review

Date: 2026-11-12. Fresh independent Ari review session. Review-only branch
`machines/security-final-delta`, authored work confined to
`D:/Projects/Ari-machines-wt/security-final-delta`.

**Bounded disposition:** no actionable security finding in the final source delta
from `8b2d0dcb14af5cc841f92fdf339388df4d026fbf` to
`e97d3a7ab0639dbf5a2b0bea083a24aeec50bad4`. The three runtime-file edits preserve
machine/session/receipt scope, separate local and remote execution, effective
grants, pinned keys and audience, one-way pairing, Auto selection and the finite
operation boundary. No generic tunnel or new capability is introduced. The prior
bounded review carries forward for unchanged code only; this is a source
equivalence check, not a fresh execution or hardware certification.

## Immutable inputs and complete delta

Read the prior independent review and proof evidence read-only under
`D:/Projects/Ari-machines-wt/security/docs/research`. The controlling review is
`machines-t3-security-final.md` at security commit
`cf467cb78377ff42582aab63a42121cb8a58f8ec`, blob
`06c428fc600f63ee6079a7c70bedfb240be8f41c`. Its on-disk file and the five result
JSON files below were independently hashed and matched that commit's blobs.
Read the route closure/reproduction, replay, combined and identity proof
instructions as evidence; executed none of their builders or harnesses.

Verified clean initial branch/HEAD at the designated target, baseline ancestry,
complete `git diff --name-status`, `--stat`, runtime/test patches, call sites and
underlying scope guards. There are exactly five changed paths in this range:

| Path | Baseline blob | Target blob |
| --- | --- | --- |
| apps/desktop/src/renderer/src/App.tsx | `7af7b48e0948680531c68b0980f7f5b870b09dc5` | `85cd9e11e4e0dcc9a6f29fc49ea36a6e211e5fb7` |
| apps/desktop/src/renderer/src/features/machines/MachinePicker.tsx | `d3ed188f1deab9999ebce6afd6131a9f1fd7e5b7` | `fce3cd5a4c8bc23d21815ffe50818701af34820e` |
| apps/desktop/src/renderer/src/features/machines/project-draft-adapter.ts | `3950eafcf76748151fc2d48fdf9433c6e4debf37` | `dd9b5b5ca2b14dcafb0b6350242120e232fcfbe5` |
| apps/desktop/src/main/root-concurrency.test.ts | `bd225d083dcc3470b69c8b4163b1d4049d57b4fb` | `776dcd031742bd09773bff4a0bdc51f0bf6734d9` |
| docs/research/machines-parity-final-2026-11-12.md | absent | `10614efd6492443ac2f68e34c7b3fad6fd07a1a1` |

The intervening commits are handoff documentation
`0a7191e75ca1c5d59fa473c3102b22b6ec53eb60`, root-workspace regression
`703de3f902cb2e3d70a102b1a3411b89dc7106d5`, and the only runtime cleanup
`e97d3a7ab0639dbf5a2b0bea083a24aeec50bad4`. The runtime cleanup totals four
insertions and five deletions. No configuration file changes in this exact range.

## Runtime equivalence and scope inspection

- **App import removal:** the unused direct `Titlebar` import is removed at
  `App.tsx:27`. App still renders `ScopedTitlebar` at line 1428; the unchanged
  `shell/ScopedTitlebar.tsx:6,25` imports and renders that same `Titlebar` inside
  its explicit session-client provider. The removed edge does not remove the
  module from this dependency graph or alter owner-scoped Git/tools behavior.
- **MachinePicker type:** `MachinePicker.tsx:16` changes `string | 'auto'` to
  `string`. The literal was already a member of `string`; the accepted type is
  identical and erased at runtime. The unchanged Auto sentinel, eligibility
  checks, disabled lock, and ProjectDraft handler at lines 281-287 remain present.
- **Remote facade:** `project-draft-adapter.ts:13` now calls `client.catalog()`
  and `client.workspaces(projectId)` explicitly. The unchanged
  `session-draft-client.ts:28-58` validates machine/draft IDs once, captures both
  IDs lexically, freezes the host facade, and defines catalog/workspaces as arrow
  closures. They do not read `this`. Direct references and the new wrappers invoke
  the same closures once with the same argument and return the same promise.
  They still call `assertMachineOperation`, send an allowlisted remote query to
  the captured machine, fence the response by authorization epoch and validate
  its schema. The wrapper cannot select another client or probe local models.
- **Local static choices:** `project-draft-adapter.ts:32-34` replaces an async
  arrow with no await by `Promise.resolve<RemoteProjectWorkspaces>` around the
  identical fresh object literal. It still resolves asynchronously to the same
  project ID, truncation flag and isolated-worktree option. The added import is
  type-only. The body performs no RPC, durable create, host lookup or fallback;
  it contains no additional potentially throwing operation. The isolated token
  remains a local presentation choice.

Inspected the unchanged surrounding lifecycle and enforcement, not just the
edited lines:

- `ProjectDraftPane.tsx:53-71` caches clients per draft and exact host ID. Only
  the explicit `hostId === 'local'` arm creates a local adapter; every other host
  receives `remoteProjectDraftClient(hostId, entry.id)`. Remote failure has no
  catch that constructs or dispatches a local client.
- `ProjectDraft.tsx:61-112,145-160,173-247` restores scoped attempts, binds the
  selected client, ignores stale option responses, and locks machine selection
  on a workspace lock, pending send, saved attempt or corrupt receipt. It checks
  checkout/catalog eligibility, captures host and model selection, persists the
  attempt before creation on first Send, verifies the returned local/remote
  owner, and stages/prompts through the same captured client. Unknown outcomes
  retain the original attempt and use read-only checks; they do not retry create
  or prompt. `machine-policy.ts` and the Auto lifecycle still refresh only the
  chosen host before dispatch and refuse busy/stale/manual-only selections
  without substituting or silently queueing another host.
- `session-draft-client.ts:30-46,59-90` retains state keyed by the exact
  `[machineId,draftId]`, creation receipts keyed by machine plus `draft:<draftId>`,
  and prompt receipts keyed by machine plus the host-issued session ID. Remote
  stage/prompt/check methods reject local or other-machine scopes; firstPrompt
  and checkPrompt additionally require the draft's created session ID.
  The local adapter's stage/prompt/checkPrompt reject remote scopes before using
  local session operations. Neither guard changed.
- `session-client.tsx:61-106` freezes a copy of the owner scope; remote views use
  the canonical machine/session tuple. Remote invokes reject a different
  session and client project-root authority, use finite command mappings and
  fail unsupported controls. Remote queries/commands go through the unchanged
  `machines.query`/`machines.command` RPC boundary. `remote-client.ts` persists
  the original envelope before IPC and resolves uncertain receipts read-only.
- `main/machines.ts:690-715,1096-1123` parses the finite contracts, requires the
  exact machine connection/capability, preserves mutation keys and rechecks the
  active connection. `main/remote-host.ts:503-517,974-1014` rechecks current
  caller/project grants, validates the host catalog and resolves workspace tokens
  against the device, project and mode before server-side creation. Key/pin,
  audience, route authority, pairing and receipt enforcement are unchanged
  across the entire Git delta. The UI cleanup does not bypass these boundaries.

The root regression was source-inspected: it retains its existing first-send
root-policy/idempotency assertions and adds parsing of host-offered workspaces,
selection of the isolated checkout token, and an assertion that the created
managed worktree's `baseCommit` equals the fixture repo's Git HEAD. It changes
test source only. This reviewer did not execute that new assertion.

## Byte-identical security boundaries

Each following blob was resolved at both the baseline and target and matched.
Prefixes: `M = apps/desktop/src/main/`,
`R = apps/desktop/src/renderer/src/`, `P = packages/`.
The complete five-path delta above also establishes that every other tracked
source, including F, Tailscale, mobile and managed Connect, is unchanged.

| Source (prefix + path) | Same blob at both commits |
| --- | --- |
| R/features/session/session-draft-client.ts | `28ada47aa3864a3f6ced78dae4b84b623bb51bf0` |
| R/features/session/session-client.tsx | `548933015c1804e8b35eac68d6c87fc7a4860f07` |
| R/features/session/session-scope.ts | `b3cee813e9902e8b93253535fa3f1796388a1908` |
| R/features/session/session-machine-access.ts | `15399bd62d62b652d3372eff44e2f0b2d834f2e3` |
| R/features/machines/ProjectDraft.tsx | `e46699a7394ea4f4fc58a61dcd345edd7082b5bc` |
| R/features/machines/ProjectDraftPane.tsx | `aad8fb7bbfb5c84041cb6966cfd631edd4993eea` |
| R/features/machines/remote-client.ts | `2ea94889b9946e803c2bd4d947673b5d2e7c8d2c` |
| R/features/machines/machine-policy.ts | `f57f38cf0831e013ab27fb356c039be5dc77ed5e` |
| M/machines.ts | `f12b34a18848743326aa77b3bf14cd7251c611f1` |
| M/machines-registry.ts | `093f6a3d56bfb87e2ea28c54f414fc487b275b37` |
| M/machines-network.ts | `137f014e2eea13fa1d66144b94e562655560b9d1` |
| M/machine-identity.ts | `b884aff7ef9aa420ab0a28e3362fc0382e62a68c` |
| M/host-signing-identity.ts | `5dacb26cd96e2d6bfee3e35c1513774b7478e60f` |
| M/remote-host.ts | `e11780109b24d47410b6b944a78464b5d404d04a` |
| M/remote.ts | `629addd6c451d215792e7cc772a99c48534f2b04` |
| M/rpc.ts | `c393ca935848811548c91cc690f7a3a9e97c2737` |
| P/contracts/src/remote-desktop.ts | `c2064d449c46dbf9a177663f1a5c6f0120dfb7a9` |
| P/remote-client/src/gateway-client.ts | `57d26dfee52e8c7346fa04f7dead513ce4f849aa` |
| P/remote-client/src/route-auth.ts | `b16da24f68d63a3ba963ee8f0483c3dbfe8cf904` |
| P/remote-client/src/session.ts | `f932743a8dc297c983a1669a1d8c5272b70ab116` |
| P/remote-gateway/src/gateway.ts | `609b2e1654a4ce770e346ea4f53322975a5f2a4d` |
| P/remote-gateway/src/pairing.ts | `b12c4dbeaf9f558a46d537e9733b0720d784b218` |
| P/remote-gateway/src/idempotency.ts | `339c854bb29686c86e2f80777826e4568f981d23` |

## Prior executed evidence and unchanged completion gates

The following results belong to the prior independent reviewer, not this fresh
reviewer's executions. Paths are under
`docs/research/evidence/machines-t3-security/` in `cf467cb7` above. Each records
exit 0 and success at its named immutable checkpoint. The prior review explicitly
compares those checkpoints to baseline `8b2d0dcb`; this review compares only that
baseline to the final target.

| Evidence / exact result blob | Prior executed checkpoint and bounded proof |
| --- | --- |
| route-closure-result.json / `d22ae2b04ebd146896ebc779b605f5d505193c84` | `dbbe9f6d0de3dddcb016e7b8f371d1c2b02b53d9`: T1 stale/equal-time routes remain removed across reload; T2 removed pending route receives no proof/publication. Actual crypto/grants with deterministic transport and fixture AES-GCM. |
| replay-closure-result.json / `6a34d920af579cb1eafe9966f8f163a7449da909` | Same `dbbe9f6d`: T3 2,100 initial rows including seq zero, exact-cursor resume/live and epoch fencing. Actual SessionClient/contracts with fixture transport/inventory. |
| combined-result.json / `29625dad225c3403a125191e8b3fd0c061f7a919` | `1c2398a4177bdc97741bbbe0d8304f6640176d04`: two actual Engines/stores and signed loopback HTTP/WS through normal SessionClient; 2,406 initial rows, fallback/move-back, single-host prompt, distinct bearer, no reverse grant, grouping, fixture Auto/Manual and B-only revoke/cache purge. Standalone assertion/spy runner; no full Vitest-suite claim. |
| identity-result.json / `13e935b93f008acc1a3108c1331942c5c6d07c97` | `c537a8e2a492f1c2dc92894cd009ff6b07e79598`: real disposable Windows files and simultaneous independent processes for fresh/legacy/missing/empty primary, recovery and signing continuity; fixture sealed storage. |
| identity-cleanup-result.json / `d2865ffc504da6fa1ac488271364d2395f4e4c16` | `8b2d0dcb14af5cc841f92fdf339388df4d026fbf`: prior identity assertions plus injected publication/cleanup failures preserving the winner and original publication error. Native-fs injections, fixture AES-GCM. |

No meaningful new runtime execution is required for these direct-call and
type/static-literal equivalences. No heavy lease was acquired, no tests/builds
or broad root checks were run, and no new worker/model/effort/permission launch
was made. Full integrated verification remains parent-owned and separately
required; its active run is not certified here.

The prior limitations remain controlling:

- Windows file flushing/no-replace publication does not establish directory
  fsync (unavailable through Node on Windows), crash/power-loss durability,
  filesystem hardlink availability, deletion of both identity/anchor files or
  arbitrary external mutation. Leftover unique identity temporaries are not
  authoritative. Cross-runtime desktop/headless profile-owner locking remains
  unimplemented and requires separate review.
- Real DPAPI/Electron safeStorage, macOS Keychain and Linux Secret Service
  restart/unavailable-keyring behavior, retained ID/key/pin and durable withdrawal
  remain platform gates. Fixture AES-GCM does not verify OS keyrings.
- Two real desktops on one tailnet and iPhone Safari/installed PWA still need
  TLS and DNS/TCP destination checks, owned non-443 Serve, approvals in both
  directions, fallback/cooldown/move-back, storage/reconnect, sleep/wake and
  network/ACL/revocation checks. No real Tailscale/mobile hardware was used here.
- Real providers/PTYs, terminal/device withdrawal and signed lease expiry,
  shutdown/descendant cleanup with F containment, and actual split-pane/terminal
  DOM/native interaction remain gates. Private Connect registration, signed
  lease renewal, project refresh/revoke, incompatible binaries and manual-update
  UX also remain unverified by this review.
- Bounded receipt retention does not promise unlimited exactly-once for a direct
  resend of a forgotten UUID. Unknown status remains read-only. Route high-water
  state must survive backward clocks without pin/credential reset; failed
  revocation persistence denies runtime authority without proving replacement
  of old disk bytes. These limits are unchanged.
- Headless services/management socket permissions, cross-runtime owner locks and
  updater trial/rollback are deferred capabilities requiring fresh runtime review
  if implemented. This report adds no runtime, headless or updater feature.

Only this report is authored. No automatic C: checkout, other worktree, live
app/profile/settings, real Tailscale, runtime source, push or PR was modified.
Later runtime changes require a new comparison against the named final target.
