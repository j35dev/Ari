# Machines host parity: proposed contracts

Research only, 2026-11-12. Not the implementation freeze. Worktree:
`D:/Projects/Ari-machines-wt/host-rework`, branch `machines/host-rework`, inspected
HEAD `9707fad911e956a546ec3922956d2a4fb42bfc92`. Only this document is authored.
The latest `machines-t3-parity.md` wins over the 2026-11-11 design and the older
composer brief. One-way pairing remains; there are no machine groups, reverse
approvals, implicit agent peer access, or transitive grants.

## Recommendation for the matrix freeze

Use the existing authenticated gateway allowlist as the host boundary. Add the
operations below individually; do not forward renderer `RpcMethod` names or
`command.dispatch` to remote hosts. The normal SessionView can consume a narrow
host adapter, with named disabled states for unsupported actions. Keep mobile
v1 snapshot/stream behavior intact; desktop history needs its own negotiated
capability and frame variants.

| Requirement | Current source | Proposed host addition / dependency | Run disposition |
| --- | --- | --- | --- |
| One execution owner | `createRemoteHost` resolves sessions, files, models and terminals on the host | Retain; every reference and receipt stays machine/session scoped | In |
| Complete normal transcript | `session.get` returns messages/requests/tasks; v1 replay materializes all history, caps at 2,000 events, lacks empty completion/runtime metadata | `events.desktop.subscribe` and `session.desktop.get`; bounded engine journal range reader | In; dependency must be accepted before renderer implementation |
| Provider/model/effort/mode readiness | `models.list`, `models.efforts` already provide catalogs, readiness, source, defaults and endpoint-backed model IDs | Reuse; no remote provider detection/login or endpoint settings APIs | In |
| Project correlation with forks | `project.list` has id/name/sessionCount, no repository identity | `project.catalog`, host repository identity resolver and shared grouping helper | In |
| Stable Auto draft selection | No host CPU/memory reader found | `host.resources`; lightweight cached sampler shared by local/remote adapters | In; default off and manual-required on missing/all busy |
| This device's permissions | `device.authorize` returns grant; `MachineView.allowTerminal` is authenticated, but `device.list` reads other devices | `host.permissions`, using the effective gateway caller | In |
| Versions / degradation | Public protocol version 1 plus Ari version and operation names | Keep protocol 1 for additive operations; `host.version` for authenticated host/update status | In |
| Remote update execution | Desktop update controller can call `quitAndInstall`, has no durable remote prepare/commit/outcome handshake | Design prepare/commit/status, do not expose existing install RPC | Defer mutation unless coordinator explicitly accepts updater work |
| Stable identity / concurrent initialization | Atomic temporary rename; malformed/empty files fail closed; separate initializers can choose different IDs | Single-owner initialization and retained recovery winner; preserve existing invalid data | In design; host-module ownership decision required |
| Routes and learned credential reuse | Current source independently pairs each origin (S1 correction) | Connection worker owns authenticated route bindings and reuse policy | Outside this worker; do not implement route reuse |
| Headless host | RemoteService bootstrap depends on Electron/profile/catalog/control wiring in `rpc.ts` | Extract reusable engine+gateway bootstrap, identity/profile lock and lifecycle; platform credentials/update adapter | Fully specify later after items 1–8, not implement during research |

## Trust and compatibility rules

Anonymous `/api/identity` and `gateway.info` retain **only** machine ID/name,
Ari version, protocol version and capability names. No project/repository names,
paths, providers/models, addresses learned from host state, resources, device
records, permissions or update runtime details belong there. Capability names
describe implementation, never this device's grant. A copied public machine ID
is not proof permitting a credential to cross origins.

All proposed reads require the existing device credential and, on the managed
gateway, the current signed Connect lease. Use `RemoteCaller` computed by the
gateway, never caller/grant/project fields accepted from a request. Session reads
check the session's stored project ID; invisible IDs have the same `not_found`
behavior as absent ones. Project catalog filters before resolving identities.
Connect remains lease-project bounded and clears `allProjects`; no new operation
may read the un-intersected pairing grant as its effective authority.

Keep exact origin policy, sealed desktop keys, lifecycle generation checks,
terminal grant/lease watchdogs and durable pairing writes. Device authentication
does not authorize host pairing approval. Hosting another machine does not
create a peer link for local Aria/worker control sockets.

New operation names are capability names. Implementations advertise only wired
dependencies. New clients gate new requests before sending; older clients retain
their current schemas. Protocol-incompatible hosts remain visible and refuse
pairing/commands. Missing desktop replay capability yields an explicit normal-view
unavailable/read-only state rather than presenting an incomplete transcript as
complete. Different Ari app versions alone are not incompatibility.

## Proposed wire surface

Every mutation below uses the current strict envelope
`{ clientCommandId, idempotencyKey, ... }`. All object schemas are strict; IDs
retain existing bounded schemas, lists/strings/frames gain explicit byte/count
limits. Responses have Zod schemas, parsed by the desktop adapter. Do not use
`unknown` results as authority to retry or to change session ownership.

### Authenticated machine reads

| Operation | Request | Result |
| --- | --- | --- |
| `project.catalog` | `{ op: 'project.catalog' }` | `{ projects: RemoteProjectCatalogEntry[] }` |
| `host.resources` | `{ op: 'host.resources' }` | `RemoteHostResources` below |
| `host.permissions` | `{ op: 'host.permissions' }` | `{ deviceId, projectScope: {kind:'all'} \| {kind:'ids',projectIds:string[]}, allowTerminal:boolean, managedLeaseExpiresAt:number\|null }` |
| `host.version` | `{ op: 'host.version' }` | `{ ariVersion, protocolVersion, hostingMode:'desktop'\|'headless', update:{supported:boolean, reason:string\|null, availableVersion:string\|null, stagedVersion:string\|null} }` |

`host.permissions` reports current effective project access, not other devices
or public keys. It is read-only and has no client-supplied device ID. Refresh after
authorization/reconnect and grant changes; clear effective permissions on
disconnect. The connection layer labels it with the active verified route and
transport generation, rather than trusting a route label in host content. A
signed lease expiry remains explicit. Terminal is true only for the effective
caller grant and is usable only when terminal operations are also supported.
No separate fine-grained permission vocabulary is invented in this run; list
unsupported functionality separately from denied grants.

`host.version` may be absent on older hosts; then use public Ari/protocol versions
and say update status is unavailable. Unknown/development version strings are
displayed, not ordered as semver. The initial `update.supported` is false with
`Update Ari on this machine` until a safe host update implementation exists.
No filesystem install location, command line, download URL or updater error stack
is exposed.

### Session reads and writes

| Operation | Exact proposed payload / result | Host dependency / restriction |
| --- | --- | --- |
| `session.desktop.get` | `{op,sessionId}` → `{session,summary,seq,pendingApprovals,pendingInputs,tasks,parent,context:{hasMessages,hasTurns,hasProviderSession},lastTurn:{turnId,stopReason,settledAt,errorMessage?}\|null,liveTurnId:string\|null,liveCapabilities:{approval,question,steer}}` | Authorized store read + live engine authority; no full transcript duplication. Same task DTO as existing remote session result. Context flags suffice; do not export raw native providerSessionId just for a boolean guard. |
| `session.dequeue` | Envelope + `{op,sessionId,text,attachmentIds?:string[]}` → `{accepted:true}` | Map to `message.dequeue`; resolve staged/transcript attachments for caller/session before matching queue identity. Engine remains final arbiter. |
| `session.provider.switch` | Envelope + `{op,sessionId,driverKind,modelId:string\|null,effort:string\|null}` → `{accepted:true,switchTiming:{effective:'ready',afterTurnId:null}\|{effective:'next_turn',afterTurnId:string}}` | Validate host catalog/provider/model/effort, then dispatch the existing engine command. Keep `canSwitchProvider` restriction; ordinary used sessions cannot switch providers. Permission mode is preserved. Return the actual engine timing receipt. |
| `session.stopChildren` | Envelope + `{op,sessionId}` → `{stopped:number}` | Dedicated subtree-stop adapter around host supervisor; authorize root and every selected descendant. Stops descendants, not the root, matching the existing local RPC. If UI wants root plus children, define separate `session.stopTree` before implementation. |
| `plan.get` | `{op,sessionId}` → `{items:{text,status:'pending'\|'in_progress'\|'done'}[]\|null}` | Extract bounded safe plan reader; use host-derived todo filename/workspace, no client path. |
| `changes.turn` | `{op,sessionId,turnId}` → `{diffText:string\|null,summary?:GitTurnDiffSummary,error?:string}` | Existing `queryTurnDiff` with stored checkpoint refs and host workspace; bound response. |
| `changes.turnFile` | `{op,sessionId,turnId,path:workspaceRelativePath}` → `{diffText:string\|null,tooLarge?:boolean,error?:string}` | Resolve base/head from that session's checkpoint/turn summary. Do not trust arbitrary client OIDs as proof they belong to this session. |
| `session.resume.get` | `{op,sessionId}` → `{at:number\|null}` | Existing shared ResumeSchedule after readiness; visible session only. |
| `session.resume.schedule` | Envelope + `{op,sessionId,at:positiveEpochMs}` → `{at:number}` | Existing schedule pins failed turn and checks host time bounds. No recurring automation or arbitrary prompt API. |
| `session.resume.cancel` | Envelope + `{op,sessionId}` → `{cancelled:boolean}` | Existing schedule instance; no separate remote timer or store. |
| `files.index` | `{op,sessionId,cursor?:string,limit?:1..200}` → `{paths:string[],nextCursor:string\|null,truncated:boolean}` | Workspace-relative, authorized, bounded walk/index; enforce remote-files secret/symlink/short-name restrictions. Local WalkCache alone is not this security policy. |
| `pastes.stage` | Envelope + `{op,sessionId,text:string}` → `{path:workspaceRelativePath,bytesWritten:number}` | Dedicated host-generated filename under `.ari/pastes/`, UTF-8 byte cap, jailed write; never accept a filename, absolute path, arbitrary mkdir or generic `fs.writeTextFile`. |

Extend `session.steer` with optional `attachmentIds` only behind a distinct
negotiated operation such as `session.steer.attachments`; resolve them exactly
like prompt/queue. This supports matching an imaged queued entry, but does not
make a provider capable of steering images. Existing engine/live capabilities
still refuse image steering; UI can instead disable it with that reason. Do not
silently drop image IDs. Add `driverKind` to desktop `session.update` only behind
`session.desktop.update`: host validates the *target* catalog/default/model/effort,
then engine permits an empty-context switch and rejects a used ordinary session.
Never validate a new model against the old provider.

Reuse `session.prompt`, queue, interrupt, update, fork, exact-option approval and
input responses, files/attachments/changes/terminal operations. `models.list`
already supplies readiness and defaults; no `providers.detect`, credentials,
provider install/login, `endpoints.list`, broad settings or shell IPC tunnel.

Expanded task/result cards use existing `session.get.tasks` initially. Disable
result diff/review/integrate/verify/retry/correct with an explicit reason until
separate scoped contracts pin task ID, result ID/version, attempt, snapshot
commit and original operation key. Do not expose `AgentControlService.invoke`
or orchestration admin wholesale. Existing reviewed `changes.integrate` remains
its own snapshot-checked path; it is not equivalent to result integration.

### Desktop event subscription

Proposed client frame:
`{type:'events.desktop.subscribe',sessionId,fromSeq?:number}`; absent `fromSeq`
means **full history including seq 0**, supplied `fromSeq` means events strictly
after that sequence. Reuse unsubscribe; introduce a desktop acknowledgement
frame if required for a real bounded send window. The desktop mode is advertised
as `events.desktop.subscribe`, not inferred from `events.subscribe`.

Server variants under a single new discriminant `type:'events.desktop.frame'`:

- Start: `{sessionId,replayStart:true,replayMode:'full'|'resume',fromSeq:number|null,throughSeq:number}`.
- Chunk: `{sessionId,events:JournalEvent[],replay:true}`; parse events with
  `journalEventSchema`, not the current opaque wrapper schema.
- Terminal: `{sessionId,replayDone:true,replayOutcome:'complete'|'incomplete',liveTurnId:string|null,seq:number}`.
- Live: `{sessionId,event:JournalEvent}`.

The shared client forwards this as a typed desktop stream; the Machines wrapper
retains its originating machine ID and local subscription/connection generation.
No stale route generation can satisfy a new pane subscription.

Subscribe to store live events **before** taking an authorized session high-water
mark H. Replay a stable journal prefix through H, buffer later live events, then
release them in sequence exactly once. Full/resume is explicit so a resumed
history finish does not prune the cached prefix. Emit a terminal even for empty
history, no-new-events resume, a failed replay or desync while authorization and
the connection remain valid. Denied/invisible subscriptions reveal no history;
revocation or closed sockets stop delivery rather than emitting private terminal
metadata. Always use `Engine.liveTurnId`, not historical `activeTurnId`, to settle
stale running UI. The implementation must define its runtime sample/buffer-drain
ordering so an H terminal cannot clear or resurrect a newer buffered turn.

There is no 2,000-event **history** cap. Keep independent bounds on chunk count
and serialized bytes, live buffered events/bytes, outstanding send window and
replay time. Proposed initial bounds: 128 events / 256 KiB per chunk, 2,000 live
events / 4 MiB buffered. An oversized event or slow-client overflow terminates
incomplete/desync; it never silently drops rows. Preserve resumable last valid
sequence, require explicit full resync if continuity cannot be proved. Do not
materialize the complete journal or full transcript result before streaming.

Existing `Engine.replaySessionChunks` has a synchronous callback and filters out
invalid journal entries. It cannot provide async backpressure or certify an
unbroken range. Required narrow engine addition: cancellable async range replay
`replaySessionRangeChunks(sessionId,{afterSeq?,throughSeq,signal},onChunkAsync)`
with explicit complete/incomplete outcome on corruption, gaps, missing prefix,
I/O failure and cancellation. A session read/barrier helper may be needed for
metadata consistency. Reuse the journal reader; do not add a second journal store
or replay background-task side effects in the remote reader.

## Project identity and fork grouping

Proposed `RemoteProjectCatalogEntry` is
`{id,name,sessionCount,status:'ok'|'missing',defaultAgent:ProjectAgent|null,repositoryIdentity:RemoteRepositoryIdentity|null}`.
It contains no absolute project path. `RemoteRepositoryIdentity` is
`{canonicalKey,displayName?,locator:{source:'git-remote',remoteName},origin?:{canonicalKey,displayName?}}`.
Raw remote URLs, auth userinfo, query strings, private keys, provider tokens and
root paths are unnecessary. `defaultAgent` is the host project's saved choice;
validate it against that host's catalog. Never replace an unavailable explicit
selection silently with a local default.

Host resolver selects valid **fetch** remotes in order `upstream`, `origin`, then
lexicographically first other name. Skip local/relative/drive/UNC/file remotes.
Use host-resolved git common root for worktrees and bare repositories; no client
path or network fetch is needed. Identity failure yields null, not an invented
shared project key. Refresh when remotes/project registration change and via a
bounded cache (proposal: capacity 512, positive TTL 15 minutes, negative 1 minute).

Match T3's normalized `host/repository-path` key across SCP/SSH/HTTPS forms,
lowercase, removing `.git` suffix/trailing slash and credentials. Known forge
rewrites must be explicit (not DNS guesses or arbitrary hostname aliases); unknown
hosts retain their literal normalized hostname. Azure SSH/HTTPS spellings need a
tested rewrite if supported. T3's key uses hostname rather than transport/port;
this is correlation only and must never bind authorization. Do not emit a raw
unparseable remote as a fallback key; it may contain credentials or a local path.

Set `origin` only when its valid normalized key differs from the selected
canonical key. Group and label using `origin?.canonicalKey ?? canonicalKey` and
the corresponding origin display name. Examples:

| Upstream | Origin | Canonical key | Group key |
| --- | --- | --- | --- |
| none | `git@github.com:Acme/App.git` | `github.com/acme/app` | `github.com/acme/app` |
| `https://github.com/Acme/App` | `git@github.com:Me/App.git` | `github.com/acme/app` | `github.com/me/app` |
| `git@github.com:Acme/App.git` | `https://github.com/acme/app.git` | `github.com/acme/app` | `github.com/acme/app` |
| none | local path / none | null | machine ID + host project ID |

This is display correlation, not repository sync or routing. A fork group cannot
offer the upstream checkout as its machine choice. Multiple checkouts of a group
on one machine retain separate project IDs; select a checkout explicitly if
ambiguous. Existing sessions stay `(machineId,sessionId)`; identity refresh must
not reassign their execution, receipts or cached transcripts. Local project data
must use the same resolver/helper instead of deriving identity in the renderer.

Branch/worktree draft selection needs shell-owner contract agreement. Proposed
`project.workspaces` uses project ID and returns bounded branch/worktree IDs and
labels, never arbitrary paths. Creation takes a host project ID and validated
branch/worktree token inside **one receipted host create transaction**, or a
durable prepared workspace ID bound to host/project/device/draft/expiry. Current
remote `session.create` bypasses local `createSession(sessionDeps,...)` and cannot
express `workspaceMode: auto|isolated|shared`; reuse the actual host creation and
workspace occupancy policy via a dependency callback, not a second approximation.
Preparation/final creation cannot switch machines after workspace/model choice.
Do not freeze exact workspace DTOs without that owner.

## Resource telemetry and Auto policy

Proposed `RemoteHostResources`:
`{sampledAt:number|null,status:'available'|'unavailable',cpuUtilization:number|null,cpuCount:number|null,availableMemoryBytes:number|null,totalMemoryBytes:number|null,reason:string|null}`.
CPU utilization is a finite **0–1 fraction across all logical CPUs**, not a
per-core summed percentage or load average. Memory fields are bytes; unknown is
null, not zero or idle. Values must be finite, nonnegative and available ≤ total.

Use a small host-owned sampler, not T3's complete native process diagnostics:
sum `node:os.cpus()` counters twice about 200 ms apart; reject count changes,
nonpositive total delta, negative/reset counters. Windows `freemem()` represents
available physical including standby; Linux prefer `/proc/meminfo` MemAvailable;
macOS use a bounded `/usr/bin/vm_stat` read if a reliable available estimate is
needed (free + inactive + speculative, no overlapping purgeable double count).
Failed platform measurement is unavailable. No `loadavg()` on Windows, PID tables,
command lines, process signaling, permanent diagnostics subscription or shell
probe loop. One in-flight sample and 5-second cache per host; demand only. Use the
same service for local reads. No new package/native executable is required for
this scope; platform helpers use built-in Node APIs and a bounded process runner.

Auto settings live on the **client**, default off. Per-machine preference has
exactly four values: Prefer, Normal, Less often, Manual only. Host telemetry does
not change a remote machine's own preferences or authorize work. Candidate
requirements: project checkout in the fork-correct group, connected compatible
authenticated host, usable selected provider/model/effort/mode and fresh complete
resources. Manual only is never selected by Auto. Stale or absent telemetry on
an otherwise eligible candidate makes selection **manual-required**, rather than
silently favoring local or another machine; no eligible candidates / all busy
also require manual. Parent must preserve this settled fail-closed behavior.

Proposed initial freshness is 15 seconds measured by client monotonic elapsed
time since the authenticated read, allowing only a bounded-age host sample; do
not rely solely on clock agreement. Proposed busy cutoff: CPU ≥ 0.85 **or**
available memory < max(1 GiB, 10% total). These numbers are tuning proposals for
matrix freeze, not inherited T3 Auto policy or swarm validation resource gates.
Prefer wins among nonbusy eligible candidates, then Normal, then Less often;
within the first nonempty tier rank by lower CPU and greater available memory,
with a deterministic saved-order tie break. Do not choose a busy Prefer host
ahead of an idle Normal host. Manual selection can proceed with an explanatory
busy/unknown state subject to the ordinary host workspace/permission checks.

Select once for a new draft and pin host/project/model/effort/mode/workspace and
receipt scope. Resources changing, another route opening or a provider becoming
unavailable must not move that draft/session. If the pinned host disappears,
retain the draft and require explicit selection/revalidation. Auto is not an
execution reservation; host occupancy can still refuse at creation. Never retry
an uncertain create/prompt on a different host or under a fresh key.

## Versions, updates and identity dependencies

Keep `REMOTE_PROTOCOL_VERSION = 1` for additive named APIs. If the accepted frame
design cannot remain additive, define a separate desktop stream version rather
than breaking mobile. Validate capability/required protocol before sending a
credential according to the connection worker's verified-route contract. Show
which named feature is unsupported and which host/client needs updating.

T3 supports remote background-service and remote desktop updates. Ari's existing
UpdateController has an immediate `quitAndInstall()` side effect and a transient
snapshot; simply allowlisting it loses the command response when the gateway
dies. Safe future API is explicit `host.update.prepare` → durable update ID,
target version and prepare token; `host.update.commit` → accepted durable intent;
`host.update.status` → pending/applied/rolled_back/failed plus observed version.
Token binds caller, host, update ID and staged target; only the prepared target
can commit. Outcome survives reconnect/restart. Installer/restart ownership,
active-run interruption, staged release verification and rollback are host
lifecycle responsibilities; explicit updater authority/grant is required before
adding mutations. Preserve no automatic downloads/retries. No implementation of
updates/headless bootstrap is implied by this research or generic terminal grant.

Current machine identity initializes using exists/read or temp-write/rename.
It preserves malformed files by disabling hosting, but two independent first
initializers can return different IDs and later overwrite the winner. For T3
parity, hold a profile/host ownership lock during initialization and publish a
single create-if-absent winner; delayed initializers reread it. Empty-file repair
requires a retained recoverable winner and serialized recovery, not a new random
ID each startup. Leave nonempty invalid data intact and fail closed. Use flushed
same-directory writes; never derive identity from addresses/hostname. A profile
lock also belongs to later headless/desktop coexistence.

## Ownership and exact wiring needs

After parent freeze, proposed host-worker ownership:

- `packages/contracts/src/remote.ts`: named operation/query/command/result schemas
  and desktop frame variants only; preserve anonymous list and mobile v1 shapes.
- `packages/remote-gateway/src/host.ts`: optional desktop metadata/range replay
  hooks and effective-caller read models; retain project checks at host.
- Focused `packages/remote-gateway/src/gateway.ts` desktop subscription/flow
  control and self-permissions sections need coordinator ownership approval.
  Gateway still rechecks credentials/grants/lease on delivery and owns durable
  command admission, visibility and receipt lookup.
- `apps/desktop/src/main/remote-host.ts`, RemoteService dependency forwarding at
  both direct and managed construction sites, new `host-resources.ts`, project
  identity/safe plan/index/paste/turn adapters and focused tests.
- Focused `rpc.ts` dependency wiring only: pass `projectCatalog`, shared resources,
  host version state, actual local creation callback, resume-ready facade,
  authorized subtree-stop facade and existing diff/plan readers. Do not route
  those through `r.invoke`, capture renderer callbacks, create duplicate timers
  or expand the control socket surface.

Engine needs accepted ownership for async cancellable range replay/continuity
and any read barrier, common-root repository identity resolver (shared local and
remote catalog), and host create/workspace selection callback. Existing dispatch
already has dequeue, provider switch and timing; retain those policies. Resume
and supervisor services already exist. Stop facade must preserve the relevant
human approval/cancellation semantics and selected descendants rather than
spoofing an agent caller. New outcome scopes for subtree actions must remain
queryable without accepting renderer-supplied descendant IDs.

The route registry/connection worker separately owns Machines routes, credential
bindings, learned route storage and client stream adapter. Shared frame/result
schema changes need coordination with that worker and the normal-session
researcher (`sess_8e7f19d7-0de1-44e9-ad9a-6a1437497872`). No code was delegated or
written. Package/lockfile changes are unnecessary for the proposed sampler.

## Security regressions and future verification

Preserve reviewed S1–S9, not merely their old mechanism: S1 copied-ID credential
relay; S2/S9 uncertain receipt loss; S3 canceled listener startup; S4 shell lease
expiry; S5 failed durable grant/revocation persistence; S6 corrupt/evicted/inflight
dedupe and no automatic resend; S7 fork wire shape/child scope; S8 exact workspace
branch ownership. Public identity equality alone cannot approve route reuse.
New mutation receipt status is read-only and original-host scoped; missing,
conflict, unsupported, expired or malformed status never proves nonexecution.
Preserve a key after post-effect journaling/persistence failure.

Future focused proof after handoff (none run during research):

1. Contract/anonymous boundary rejects every new read without credentials;
   public identity has no added content. Managed catalog/permissions/session/tree
   actions respect signed project intersection and lease expiry.
2. Real two-engine/two-gateway stream proof: >2,000 events, seq 0, empty journal,
   zero-new resume, incomplete/corrupt range, bounded slow client, append during
   replay, cancel/revoke/remove/host restart and old host capability degradation.
   Cached prefix survives resume; complete full history removes obsolete cache;
   live turn metadata never resurrects a historical run.
3. Git fixtures: SCP/HTTPS/SSH equivalence, upstream+fork, equal origin/upstream,
   custom remote ordering, partial clones, bare/common-root worktrees, local-only
   remotes, credentials/query stripping, missing folder, changed remotes and
   multiple checkouts. Grouping does not merge forks into upstream or move sessions.
4. Fake CPU/memory sources verify reset/hotplug/invalid/unknown/stale readings,
   units, shared concurrent sampling/cache and no demand when Auto off. Deterministic
   selection covers four preferences, missing data, all busy, tier ordering,
   sticky draft and no cross-host retry after uncertain create.
5. Provider switch enforces canSwitchProvider/context/host readiness, preserves
   permissions and returns same-key original timing. Queue attachment identity,
   subtree authorization/stop semantics, pinned resume failure, checkpoint refs,
   paste jail/byte limit and index secret/symlink/8.3 filtering are tested.
6. Startup identity races and retained recovery winner, failed writes, host restart
   version status, denied/update-unavailable states and Connect preservation.

All heavy validation later uses `scripts/coordination/run-heavy.mjs`, below-normal
priority, one test worker/no file parallelism; dev consumes one of two slots.
No builds, installs, tests, live changes, pushes or changes to `D:/Projects/Ari`,
the C: managed launcher, reference checkout or real Serve occurred here.

## Evidence inspected

- Latest brief: `C:/Users/user/AppData/Roaming/@ari/desktop/aria/briefs/machines-t3-parity.md`;
  older composer brief only for unchanged normal-view constraints.
- Ari `docs/design/machines.md`, `docs/research/machines-security-review.md` final
  S1–S9 dispositions, final review, resume review and core validation references.
- Ari remote contracts/host/gateway/pairing, RemoteService direct+managed wiring,
  `rpc.ts` session creation/resume/stream/plan/turn diffs, Engine liveTurnId/replay,
  engine dispatcher/projection/project store, machine identity, remote files/fork,
  ResumeSchedule and UpdateController source.
- T3 read-only checkout verified exactly
  `6577c6b6185167c0e502fa01f9e8e8f2dee6ff25`: `docs/internals/remote.md`,
  `connection-runtime.md`, `environment-auth.md`, `resource-telemetry.md`,
  `server-updates.md`, `docs/user/updating.md` / `project-settings.md`,
  `apps/server/src/project/RepositoryIdentityResolver.ts`,
  `packages/contracts/src/environment.ts`, `apps/server/src/resourceTelemetry/HostResources.ts`,
  resource telemetry contract, shared git normalization and source-control key registry.
  Behavior adapted; no T3 code copied or reference files modified.
