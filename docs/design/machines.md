# Machines and remote access

Status: T3 parity matrix and design, 2026-11-12. Supersedes the earlier dedicated
remote workspace, separate remote sidebar, no-load-balancing and
independent-origin-only product direction. Those describe the baseline, not the
target; their security guarantees remain mandatory.

Ari baseline: `14e43fe1fdfc2f83503ba3d9f43951564f57f652`.
Authoring: `machines/parity-rework`, `D:/Projects/Ari-machines-wt/parity-rework`.
This is the first design deliverable, with no code/contracts changed. Concrete
freeze proposals and boundaries are in
[machines-parity-contracts.md](../research/machines-parity-contracts.md).

## Evidence and interpretation

The controlling brief is the desktop Aria `machines-t3-parity.md`, with the
parent's corrections: desktop uses normal Ari sessions/tools, one sidebar entry
per repository, a stable draft choice and permanent session host; mobile is
unchanged. Pairing approves only one direction, with no reverse/group/transitive
grants. Auto uses authenticated CPU/memory and defaults off.

T3 evidence is the clean, read-only upstream checkout
`D:/Projects/t3code-source-control-reference`, origin
`https://github.com/pingdotgg/t3code.git`, commit
`6577c6b6185167c0e502fa01f9e8e8f2dee6ff25`. The separate `D:/Projects/t3code`
checkout is a different fork/older snapshot and is not the matrix's anchor.
References mean the pinned source, not later releases. Behavior is paraphrased;
no source snippets are copied. T3 is MIT licensed, copyright 2026 T3 Tools Inc.;
any subsequent source reuse must retain its MIT notice.

Evidence keys (T paths at the pinned T3 commit; A paths at Ari baseline):

- **T1**: `docs/user/remote-access.md`, `docs/internals/remote.md`,
  `docs/internals/overview.md`, `docs/internals/glossary.md`.
- **T2**: `docs/internals/connection-runtime.md` and
  `packages/client-runtime/src/connection/{driver,supervisor,resolver,routes}.ts`.
- **T3**: `apps/server/src/environment/ServerEnvironment.ts` and tests.
- **T4**: `apps/server/src/project/RepositoryIdentityResolver.ts` and tests;
  `packages/contracts/src/environment.ts`, `packages/shared/src/git.ts`,
  `packages/source-control-core/src/shared/definition.ts`.
- **T5**: `docs/user/{composer,thread-sidebar,project-settings,permission-modes}.md`;
  `apps/web/src/hooks/useLoadBalancedEnvironment.ts`,
  `apps/web/src/components/settings/LoadBalancingSettings.tsx`,
  `packages/client-runtime/src/load-balancing.ts`.
- **T6**: `docs/internals/{resource-telemetry,environment-auth}.md`,
  `apps/server/src/resourceTelemetry/HostResources.ts`,
  `apps/server/src/auth/RpcAuthorization.ts`.
- **T7**: `docs/user/{updating,background-service}.md`,
  `docs/internals/server-updates.md`.
- **T8**: `docs/user/{portable-handoffs,voice-input}.md`,
  `docs/internals/mobile-navigation.md`, `apps/server/src/peer/RemoteDelegation.ts`
  and linked-machine context in `docs/user/composer.md`.
- **A1**: `packages/contracts/src/{machines,remote}.ts`;
  `apps/desktop/src/main/{machine-identity,machines-registry,machines,machines-network,machines-rpc}.ts`.
- **A2**: `packages/remote-client/src/{session,gateway-client}.ts`;
  `packages/remote-gateway/src/{gateway,pairing,idempotency}.ts`;
  `apps/desktop/src/main/{remote,remote-host,remote-terminals,remote-integration}.ts`.
- **A3**: `apps/desktop/src/renderer/src/App.tsx` and renderer
  `features/machines/{RemoteWorkspace,RemoteSession,RemoteMachineGroups,RemoteConfiguration,RemoteTools,RemoteTerminal}.tsx`,
  `features/machines/remote-client.ts`.
- **A4**: [resume review](../research/machines-resume-review.md),
  [S1-S9 security review](../research/machines-security-review.md),
  [final integrated review](../research/machines-final-review-2026-11-12.md).
  Their tests apply to their named snapshots. This design reruns none and does
  not certify new parity behavior.

## T3 parity matrix

**In/core** means required items 1-8 desktop work and verification. **In/after
core** means the next phase, reported explicitly if unfinished this run.
**Preserve** retains existing behavior/guarantees. **Out** is intentionally
excluded. Ari today always means the baseline above, not concurrent worker edits.

| Behavior / evidence | T3 behavior | Ari today at `14e43fe1` | Ari plan | In/out and reason |
| --- | --- | --- | --- | --- |
| Execution ownership (T1; A2) | Environment owns providers, execution, files and durable state; transport reaches that server. | Gateway/engine execute on host through remote allowlist. | Preserve host execution behind shared local/remote normal-session facade. Never substitute client files, credentials or paths. | Preserve + In/core: foundation for all actions. |
| Stable identity (T1/T3; A1) | Environment ID survives restart/address change; saved catalogs client-local. | Host `identity.json`; separate local registry ID scopes state. | Distinguish host ID, local machine ID, route, project and session IDs. Session owner never becomes an address. | In/core: reliable grouping and reconnect. |
| Atomic ID/recovery (T3; A1/A4) | Complete no-overwrite publication; empty-ID recovery retains a winner for delayed initializers. | Unique temp + rename; corruption blocks remote host and preserves local RPC. No concurrent-winner recovery contract. | Exclusive profile ownership, no-replace/flushed publication and retained recovery winner. Empty repair only with consistent recovery evidence; no silent corrupt-ID/key reset. | In/core: running identity cannot change. |
| Public descriptor (T1/T2; A1) | Fresh anonymous descriptor checks identity/reachability without credential. | `/api/identity` and `gateway.info`; public version/capabilities. | Minimal no-store descriptor; negotiated signed host proof for reuse. Public ID is only a hint. | In/core: descriptor alone cannot authorize reuse. |
| Saved client registry/removal (T1/T2; A1) | Local profile saves connections; removal closes scope/credentials/client state. | Registry/sealed credential; remove closes streams, attempts self-revoke. | Atomic v2 migration preserves IDs/drafts/receipts/origin bindings. Remove source-dependent learned routes and all in-memory auth. | In/core: no cross-client catalog sync. |
| Canonical repository identity (T4; A1) | Choose network fetch `upstream`, then `origin`, then deterministic other; ignore local/file remotes. | `project.list` has ID/name/count, no repo identity. | Host resolves authorized redacted canonical identity and chosen remote metadata; client never reads remote Git paths. | In/core: correlate real clones. |
| Fork grouping/labels (T4; A1/A3) | Differing origin retained; grouping key and display label use origin, not upstream. | Separate machine groups, no clone/fork correlation. | Group by `origin.canonicalKey ?? canonicalKey`; prefer origin label. Fork never collapses into upstream or another fork. | In/core: replaces plain normalized-remote rule. |
| Normalization/unknown repos (T4; A1) | SSH/HTTPS host-path keys, provider aliases; unknown remains environment-local. | No identity/grouping contract. | Normalize fetch URL spelling/.git/trailing slash/case/known provider aliases host-side; strip secrets. No grouping by basename/path/name; explicit host-local candidate for duplicate clones. | In/core: ambiguous checkouts cannot be selected by inference. |
| Normal sidebar (T1/T5; A3) | Grouped repository with environment-local threads. | `RemoteMachineGroups` separate section and dedicated workspace. | One normal repository group, sessions labelled by machine and immutable scoped IDs. | In/core: explicit user direction. |
| Normal session/tools (T1/T5; A2/A3) | Same client interfaces operate against environment RPC. | Dedicated view implements allowlist, not all normal controls. | Shared transcript/composer/Changes/files/terminal/splits/actions; narrow safe remote additions. Unsupported capability disabled with reason in normal UI. | In/core: no dedicated-view fallback. |
| Normal-view operation gaps (T5; A2/A3) | Server-supported methods, explicit capability degradation. | Parent research identifies dequeue, attachment steer, provider/driver switch, tree stop, plan, turn diff, resume, file index/paste staging and replay conversion gaps. | Freeze exact typed reads/mutations and genuine journal/event sentinel conversion. Never expose raw `providers.detect`/`endpoints.list` or generic desktop RPC. | In/core: integration must not silently dispatch locally. |
| Composer machine selector (T5; A3) | Environment accompanies new thread; catalogs/defaults from chosen host. | Separate remote host/project chooser; normal composer has no machine choice. | Selector under normal composer, only authorized hosts with repository; Auto when enabled. Host model/provider/effort/permissions/defaults follow choice. | In/core: desktop only. |
| Draft stability (T5; A3) | Auto resolves once; reselect Auto resamples; host/branch/worktree locks choice. | Remote drafts scoped; normal flow not unified. | Persist draft ID/revision/resolved host. Telemetry/routes/rerenders never change it. Manual host switch explicit, blocked for uncertain create or unreconciled staged files. | In/core: selected branch/worktree fixes host. |
| Session host permanent (T1/T5; A2) | Existing thread remains on creation environment. | Remote session machine-scoped. | Persist host/project/session identity forever; routes change transport only. Workers inherit parent host unless explicit peer grant. | Preserve + In/core: no active migration. |
| Auto/preferences (T1/T5; A1) | Off by default, client-local Prefer/Normal/Less often/Manual only, initial Normal. | No Auto setting/preferences. | Desktop opt-in; ordered tiers Prefer, Normal, Less often. Manual only excludes Auto, not manual. Show preference section with multiple available machines. | In/core: supersedes no-load-balancing direction. |
| Authenticated CPU/memory (T6; A1/A2) | Orchestration-read aggregate host sample, on demand, 5s cache; separate from full diagnostics. | No remote resource operation. | Authorized aggregate-only CPU/count/available/total bytes; local equivalent. Only unresolved Auto drafts sample; no anonymous/process/path inventory. | In/core: real host capacity required. |
| Auto eligibility/scoring (T5/T6; A1) | Connected project/provider candidates, <=15s fresh; CPU <95%, memory available >5%; weighted CPU idle × memory fraction × count. | Manual only. | Ari adaptation: samples <=30s old, CPU <85%, available memory >=1.5 GiB and >=10% of total. Order eligible hosts by preference tier, lower CPU, more available memory, then stable machine ID. Revalidate the selected grant/project/provider and resources at send. None eligible => manual choice. | In/core: conservative host admission; no silent queue or local fallback. |
| Ordered multi-route machine (T1/T2; A1) | One ordered catalog with type-speed insertion and reorder. | Route array exists; registry creates one route, service uses original origin only. | Stable IDs/order/provenance; authenticated association only. Tailscale HTTPS now, kinds extensible. | In/core: addresses separate from host. |
| Route walk (T2; A1) | Brief checks skip silent routes, first usable wins; late pass if all ordinary routes fail. | One origin + reconnect. | Bounded checks (T3 starting policy: 500ms shared head start, 2.5s descriptor deadline), ordered attempts, close failed scopes, late pass. | In/core: unavailable address cannot hide working route. |
| Route failure/version stop (T2; A1/A2) | Route failure continues; incompatible same server stops walk. | Protocol mismatch/unsupported operation visible, no walk. | Continue unreachable/auth/TLS/ID/binding failure without credentials; only pinned/authenticated-host incompatible protocol stops whole walk. Missing operation disables only operation. | In/core: fake copied-ID version cannot poison route selection. |
| Move-back preflight (T1/T2; A1) | Earlier routes checked on network/foreground/minute, authorized prepare before reconnect. | No earlier-route probing/move-back. | Keep current connection until earlier descriptor/host proof/auth/readiness works; fence route edits/removal/revocation. Resume reads/streams, never mutations. | In/core: same session owner. |
| Cooldown/retry owner (T2; A2) | Better-route failure 5m cooldown, silent checks back off to 30m, jittered retry resets after stable connection. | Session reconnect/cancellation, no route supervisor. | One supervisor per saved machine; monotonic 5m failed-switch cooldown, 1s-to-5m jitter retry, 30s healthy reset. Network wake resets silent checks, not security denial. | In/core: no competing loops or bounce. |
| Learned route source/lifetime (T1/T2; A1) | Authenticated config reports LAN/tailnet; credential derives from source route; disappears with source/report withdrawal. | Discovery hints only. | Revisioned signed host manifest and source credential provenance; complete empty report removes learned routes, absent field does not. Saved routes untouched. | In/core for Tailscale: public hints cannot promote trust. |
| Route management (T1/T2; A3) | Routes view/reorder/remove; learned reorderable, not removable. | Rename/reconnect/remove machine only. | Routes panel In use/status/saved/learned/source. Source removal deletes dependents; final-route removal requires explicit forget-machine path. | In/core: provenance and cleanup visible. |
| Credential reuse/binding (T2/T6; A1/A4) | Learned route resolves source credential; public descriptor checks ID. | S1 fix keeps key isolated to original origin; copied ID never inherits credential. | Pinned host key + authenticated exact-origin manifest/grant, fresh signed host proof, audience-bound device challenge, route-specific token. Never forward old bearer. Legacy origins stay independent. | In/core subject to security freeze: mechanism changes, S1 guarantee stays. |
| HTTPS downgrade (T2; A1/A4) | T3 source exempts some HTTP tailnet routes; otherwise secure-paired token cannot be borrowed by insecure LAN/public route. | Production Tailscale HTTPS, loopback tests; DNS/TLS/origin pinned. | Stricter user rule: HTTPS-issued authority never goes to plain HTTP, even tailnet IP. Learn HTTPS FQDN only; loopback test-isolated. | Preserve + In/core: explicit no-downgrade adaptation. |
| One-time host pairing (T1/T6; A2) | Fresh link/QR per device; existing session reconnects without original link. | Host-local approval + confirmation for P-256 key; sealed desktop key. | Retain Ari approval; bind host ID/key/device fingerprint to invitation/result. Fragment-only transient link secret, never log/screenshot it. | Preserve + In/core: T3 convenience with Ari approval boundary. |
| One-way revocation (T1/T6; A2/A4) | Host owns its issued sessions/scopes. | Host device grant, no reciprocal approve route. | A approves B => B controls A only; reverse needs approval on B. No group/transitive grants. A revocation removes B source/derived route access on A only. | Preserve + In/core: supersedes earlier group proposal. |
| Link from unsaved address (T1/T2; A1) | Existing-machine link at new address refused; Add route path, same-address re-pair allowed. | Same public ID at new origin creates separate independently paired record. | Refuse auto-merge/redemption; offer authenticated Add route on existing host. If offline/legacy, explicit separate pairing remains isolated pending verified migration. | In/core: link never authorizes reuse. |
| Your permissions (T1/T6; A1/A2) | Current session scopes beside Routes, In use only; other routes not checked. | Authenticated `allowTerminal`, no consolidated view. | Route-labelled effective project scope, terminal, operation grants/caps/expiry. Offline is last-known; public capability never grants shell. | In/core: display authority without widening it. |
| Host model/permission defaults (T5/T6; A2/A3) | Environment/project defaults and policy/provider caps; scopes cannot widen through exchange. | Catalog/efforts/modes/grant exposed to separate UI. | Host validates provider/driver/model/effort/mode/ceiling for create/follow-up; chosen host refreshes choices. Machine Auto distinct from permission mode Auto. | In/core: preserve Ari modes, no T3 provider-policy clone. |
| Version/capability degradation (T1/T7; A1/A2) | Same protocol required, optional capabilities, named side needs update. | v1 operation capability checks and incompatible state. | Ari release != wire version; additive extensions negotiated. Incompatible machine/session stays visible; renewal rechecks. | In/core: no half-upgraded actions. |
| Connected-host update status (T7; A1) | Offers update/server/app or copy exact install/relaunch guidance per installation. | No Machines updater; desktop updater separate. | Authorized installation/update status and named target/version/channel/manual instruction. No arbitrary shell update. | In/core: honest recovery path. |
| Remote update transaction (T7; A2) | Launcher stages/preflights, durably tracks ID, trial/commit readiness, rollback; reconnect checks ID/version. | No headless launcher remote transaction. | Prepare/commit/status design; desktop adapter only if existing updater provides durable receipt/restart ownership. Otherwise manual host update this run, implement with launcher later. | In/after core conditional: reconnect is not update success; unknown commit never resent. |
| Restart continuation (T7/T8; A2) | Host preference resumes supported runs; terminals can stop; handoff preserves context, not machine migration. | Host history/recovery exists; T3 policy parity not established. | Preserve Ari recovery and authoritative interruption/resume guidance. Route reconnect does not schedule automatic continuation. | Preserve; new continuation policy Out: separate lifecycle feature. |
| Headless commands (T1/T7; A1/A2) | `t3 up/serve/pair/status`, flags/JSON/noninteractive, pair without host restart. | Electron host bootstrap; CLI targets engine, not full gateway host. | `ari host up/serve/pair/status` after core; same engine/gateway/identity/grants/routes, one profile owner, script-safe explicit flags. | In/after core: large bootstrap, report exact unfinished list. |
| Background service (T7; A2) | Linux systemd user/macOS login launchd; Windows prints foreground command; uninstall retains data. | Desktop host lifecycle only. | User-owned opt-in launcher/services, Windows foreground instructions, no root/service/plaintext fallback. | In/after core: platform proof required separately. |
| Agent peer access (T8; A2) | Linked beta reads/delegates through explicit peer link; UI connection not link. | Aria/CLI local engine; no Machines peer runtime. | Client pairing gives host agents no client registry/key. Aria/workers require explicit source-host -> target-host scoped grant and ceiling; ordinary children stay on parent host. | Denial Preserve/In/core; peer implementation Out: avoid implicit reach. |
| Portable context/voice (T8; A2/A3) | Host history handoff; explicitly chosen transcription environment, no substitution. | Existing tools/voice separate flows. | Preserve tool identity; Auto/routes transfer no provider state, host files or microphone destination. Unsupported remote tools disabled with reason. | Preserve; expansion Out: separate capability/consent design. |
| Tailscale/Serve (T1/T2; A1/A4) | Route uses environment auth; shared address range alone not Tailscale proof. | Tailnet HTTPS/DNS/TCP pinning, bounded peer discovery, safe non-443 Serve ownership. | Preserve network policy; signed learned FQDN from owned Serve/tailnet state, not inferred `100.64/10` trust. | Preserve + In/core: chosen transport. |
| LAN (T1/T2; A1) | Learned when network access enabled. | No production LAN. | Model kind/provenance, setting off by default. No learn/probe/bind/use while off; HTTP cannot borrow HTTPS authority. | Model In/core; runtime Out/default off: user chose Tailscale. |
| Relay/SSH/remote-only desktop (T1/T7; A1) | T3 Connect/SSH bootstrap/local-server-disable supported. | Existing Ari Connect phone route, no Machines relay/SSH lifecycle. | Preserve Connect signed leases and future route seam. No hosted relay, SSH bootstrap or local-server-disable redesign. | Out: explicit scope; Connect remains working. |
| Mobile (T1/T5/T8; A4) | Manual selector, native navigation and remote settings. | Existing computer switcher and origin/receipt protections. | No UI/behavior change. Future new-chat selector needs authorized grouped catalogs, phone draft locks and touch-safe picker; no Auto. | Preserve; new mobile features Out: explicit instruction. |
| Receipts/no local fallback (T2; A2/A4) | Transport reconnect does not replay mutations; operation owns idempotency. | S2/S6/S9 unknown receipts retained, read-only status; host-scoped files. | Exact host/session/key/fingerprint survives route/restart. Absence/conflict/internal error/IPC uncertainty/malformed success never resends or executes locally/on another host. | Preserve + In/core: release regression gate. |

## Product and repository ownership

A route means reachability; a repository group means correlation. Neither grants
authority, synchronizes files or migrates sessions. Every normal-view action,
stream, attachment, approval, diff, file preview, terminal and split-pane target
carries immutable host scope. Unsupported methods stay disabled with a named
reason; no generic desktop RPC tunnel or dedicated workspace is acceptable.

Settings -> Machines manages hosts this PC can use. Mobile access retains devices
that can use this PC, including computer approvals. Outbound preferences/catalogs
are client-local; host grants/provider defaults/project settings stay host-local.
Offline/incompatible sessions remain in normal sidebar and show last-known
transcript read-only with reconnect/update guidance. Mobile remains unchanged.

Auto resolves an opted-in new draft once. Selecting Auto again resamples; choosing
host/branch/worktree fixes it. A failed creation retains its original host and
receipt. Host-staged attachments require explicit discard/re-stage before a manual
switch. Existing session host is permanent; route replacement is only transport.

| Example host remotes | Canonical key | Grouping key / outcome |
| --- | --- | --- |
| `origin=https://github.com/acme/app.git` | `github.com/acme/app` | Same key; SSH clone joins same repository. |
| `upstream=git@github.com:acme/app.git`, `origin=https://github.com/alice/app.git` | `github.com/acme/app` | `github.com/alice/app`; separate labelled fork. |
| Same upstream, Bob origin | `github.com/acme/app` | Bob's origin key; separate from Alice/upstream. |
| Local/file remote only, no usable network remote | unknown | `(machine, project)` scoped; path/name never joins. |
| Two clones with same key on same host | same key | One repository group, explicit checkout candidates, never guess path. |

Host normalization uses fetch URLs, deterministic precedence and known provider
aliases; `.git`, case and trailing-slash conformance needs fixtures, including
Azure SSH/HTTPS spelling. Strip userinfo/query/fragment from transmitted metadata.
Unknown aliases stay separate. Identity enrichment is asynchronous; unavailable
differs from confirmed removal. Regrouping never changes open draft/session owner.

## Route security and threat notes

S1's origin isolation is the safe baseline mechanism. Multi-route parity may
replace that mechanism only with cryptographic approval of exact route audiences;
the independent reviewer must confirm the actual implementation:

1. Public ID/descriptor/discovery/link cannot merge grants, authorize reuse or pin
   replacement keys. Pin host signing identity on already host-approved original
   origin, then accept authenticated signed manifest. Legacy origins remain
   independently paired until explicit verified upgrade/migration.
2. Route grant binds host ID/key, exact normalized origin (scheme/host/port), source
   route/device authority, revision, expiry and allowed transport. Host signs only
   its owned configured exposure; never blindly signs client-supplied addresses.
3. Before client credentials, verify fresh anonymous descriptor and signed nonce
   host proof for pinned key/exact audience. Server derives audience from trusted
   gateway/Serve configuration, never reflected Host/X-Forwarded/client fields.
   Device challenge is single-use audience/device/grant-bound; resulting bearer
   is route-specific. Original bearer never travels to another origin.
4. Preserve valid TLS/hostname, tailnet DNS/TCP pinning, exact HTTP/WebSocket origin,
   no redirects, renegotiation on renewal/replacement. HTTPS authority never
   downgrades to HTTP. Loopback is disposable-test-only, never learned production.
5. Host signing key/ID have exclusive profile ownership, flushed atomic publication
   and consistent persistent recovery. Loss/corruption blocks host/reuse; no silent
   key reset/plaintext fallback. Rotation needs authenticated continuity or explicit
   host re-pairing, never public metadata matching.
6. A approving B grants only B -> A control. Reverse requires B approval. No
   group join, transitive link or self-approval. A revokes B source grant/all its
   derived route tokens on A; separate A grant on B survives.
7. Learned route lifetime follows complete authenticated manifest and source
   grant, monotonic revision. Public probing cannot refresh/restore trust.
   Missing versus empty report, source removal and late probes have distinct
   semantics. User-saved routes persist but revoked reuse authority does not.
8. Only pinned/authenticated-host incompatibility stops walk. Failed endpoint
   receives no credential and changes no current grant/catalog/transcript/receipt.

### S1-S9 guarantees retained

| Finding | Parity invariant |
| --- | --- |
| S1 | No copied public ID credential reuse; exact authenticated route binding changes mechanism only. |
| S2 | Unknown named error/conflict/invalid success retains exact receipt; controls query status only. |
| S3 | Serialized starts/stops, generation fencing, no late listener/auth/stream publication after removal. |
| S4 | Managed PTYs retain verified lease expiry; explicit grant, no cross-mode resurrection, shutdown cleanup. |
| S5 | Sensitive writes throw and runtime denies on failure; corrupt auth/history blocks hosting; no false durable success. |
| S6 | Durable claim before dispatch, unresolved claims pinned, corrupt restore denied, absent history unknown, never resend. |
| S7 | Actual fork `sessionId` shape; child actions/receipts scoped to child through normal-view conversion. |
| S8 | Exact full-ID branch ownership; preserve ambiguous legacy/foreign branches and external junction targets. |
| S9 | Integration applied before journal conflict stays unknown; retain preview/key and inspect host, no re-integration. |

Bounded v1 cannot guarantee arbitrary-old exactly-once direct replay of evicted
UUIDs; terminal receipts are memory-only. Neither limitation permits resend on
route failover. Failed withdrawal needs a successful save before restart or last
durable grant can return; retain explicit warning. Host path/sensitive-name/
symlink/realpath/opened-handle containment and session/device attachment grants
remain. No remote path/action falls back to local filesystem/engine.

## Existing Serve, grants and Connect guarantees

Ship-first Serve recovery remains intact: default enable never overwrites foreign
root, prefer free 8443 if 443 busy, replacement names exact observed
origin/root/kind/target and rechecks before write, preserves sibling mounts. Status
includes selected port/listening/ownership/conflicts/suggested port; URL/origin
includes port. Profile ownership record, not target equality, permits gateway-port
repair. Unknown/unreadable/Funnel mappings fail closed. Disable removes only Ari's
recorded root, never resets Serve. External CLI mutation between inspect/write is
not atomic; crash before ownership save leaves unclaimed mapping. Fake runners
and disposable profiles only; never mutate user's real Serve.

Direct devices retain all-project grant and separate explicit terminal access.
Connect retains signed account/device/key/project scope and maximum 120s managed
lease; no wildcard/permissive migration/unbounded expiry. Current registration
refresh does not grant a new project without freshly signed lease. Existing Ari
Connect must continue working. No private service deployment/verification claimed.

## Versions, updates and headless after core

Items 1-8 precede headless. Ari release and protocol versions are distinct;
additive capabilities permit degradation. Unsupported control names missing
capability; incompatible named host stays visible. Do not hide/clear history,
auto-downgrade, or update on reconnect.

T3 offers connected-host updates. Ari first exposes installation/target/channel
support and accurate manual instructions. Remote mutation requires staged install,
preflight, durable update ID, prepared/committed handoff, migration/readiness gate,
status/version correlation and launcher-owned rollback. Desktop adapter must use
existing updater, not arbitrary shell execution. If it cannot meet transaction
requirements this run, ship manual guidance and report remote execution unfinished.
Unknown commit only reconciles; reconnect alone is not success. Show host-authorized
interruption/resumable counts where available; do not add automatic continuation.

Headless proposal uses `ari host` namespace to avoid existing CLI collisions:
The full bootstrap, CLI, profile-lock, approval-channel, service and updater
design is in [machines-headless.md](machines-headless.md); it is not implemented.

The proposed commands are:
`up` selects explicit reachability/service choice, `serve` foreground engine+
gateway, `pair` fresh link and host-local approval, `status --json` separates
configured/listening/ready/reachable/auth/update state. Noninteractive flags never
auto-approve devices or widen exposure. Linux user-systemd/macOS login-launchd
optional; Windows prints foreground command. Same identity/grants/journal/routes,
one desktop/headless owner per profile; uninstall preserves user data.

If unfinished, exact remaining headless work: Electron-independent bootstrap and
lifecycle; OS secure key/provider-login adapters; launcher/profile lock; local
approval control channel; foreground/JSON CLI; Linux/macOS service adapters;
durable updater/rollback; packaging; restart/migration/revocation tests; fresh
security review and disposable-platform proof. Detailed contracts are separate.

## Ownership, verification and release gates

Design owns this document and separate contract proposal only. Core owns schema/
package/lockfile, identity/registry/route crypto, telemetry/repository metadata,
gateway/main RPC and real two-host proof. Normal-session research/renderer owns
shared facade, genuine replay/event conversion, selector/sidebar/normal view and
screenshots. Parent freezes interfaces and section/file overlaps before fan-out.
Security independently confirms final route/Auto/pairing/update/headless boundary.
Mobile stays unchanged; shared extensions preserve older consumers. Preserve
standalone Serve/parallel-worktree fixes and off-by-default Aria experiment guards.

No installs/builds in C: launcher or user's `D:/Projects/Ari`; no changes to other
worktrees/live Ari/settings/Serve/private Connect, no push/PR. Heavy steps use
existing `scripts/coordination/run-heavy.mjs`, below-normal priority, one worker,
no file parallelism. Dev occupies one of two slots. Admission: C: >=5 GiB free,
commit headroom >=1.5 GiB; second slot only >=6 GiB headroom. Physical RAM is not
gate. Commit WIP first, heartbeat leases, reclaim stale lock only for dead owner,
wait/recheck transient gate, report persistent 15-minute gate or killed/OOM step
without retry storm. This design performs only lightweight reads/doc verification.

Required new proof uses two actual engines/gateways with mock providers, not mock
engines/transport: separate approvals both directions/no reverse/transitive grant;
clone/fork grouping/permanent host; normal queue/steer/dequeue/stop/approval/input/
files/Changes/terminal; ordered fallback/move-back/cooldown/learned lifetime;
copied-ID/challenge relay/key change/wrong origin/no HTTP downgrade;
authenticated Auto/freshness/preferences/draft locks; version/capability mismatch;
unknown mutation never resend/local fallback. Add updater/headless proof only if
implemented. Capture selector, one-repository/two-host sidebar, remote normal
session and Machines Routes/Your permissions, light/dark, disposable profiles.
Affected checks first, full integrated suites/builds once at end under lease.

Remaining hardware/private-service gates: two desktops/iPhone same tailnet;
non-443 PWA pair/reconnect; sleep/wake/network/ACL; real PTY grant/lease/descendant
cleanup; sealed keys/host identity across restarts; real headless service/update
rollback if shipped; private Connect registration/lease refresh. Prior A4 results
are baseline evidence. No new screenshot, runtime/hardware or security
certification is claimed by the first design deliverable.
