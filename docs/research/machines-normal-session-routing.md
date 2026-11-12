# Machines: normal SessionView routing research

Research only, 2026-11-12. Inspected `machines/session-rework` at
`8a4b7c00f54553074fc5aee5d1d3369acf7b6350` in
`D:/Projects/Ari-machines-wt/session-rework`. The latest user brief is
`machines-t3-parity.md`. This document inventories Ari's current architecture;
the design worker owns the T3 parity matrix and the parent freezes contracts.
No application, main-process, contract, mobile, build, installation, live-app,
Serve, or user-checkout change accompanies this research.

## Recommendation and required handoffs

Render host-owned sessions through `SessionView` and its normal transcript,
composer, approvals and questions. Bind a typed session client to an explicit
machine/session reference before rendering. Every descendant that reads or
changes host state must obtain that same client. It must not delegate an
unsupported method to the global local `rpc` client.

Keep the exact wire session ID separate from the composite renderer key.
The transport adapter owns wire translation and durable mutation receipts;
components own presentation and client-side draft editing. Machine selection
for a new draft does not change the owner of an existing session.

Three contracts must be frozen before implementation:

1. Explicit machine/session identity and the shell-to-SessionView client prop
   or context, including composite keys for every store and pane.
2. A desktop-only full journal replay capability with bounded chunks, an
   explicit terminal and a runtime-owned live turn boundary. Existing mobile
   v1 frames cannot supply the normal desktop history lifecycle completely.
3. Exact narrow operations added now, and capability-specific disabled controls
   for all remaining methods. Parent explicitly requires visible ordinary
   transcript cards with unavailable actions disabled and explained.

The host worker (`sess_bad8972b-a32d-47ea-a593-e704760b7575`) proposed
`events.desktop.subscribe`; exact DTO recommendations were sent directly.
The names below are recommendations until the parent/design matrix freeze.

## Existing boundary

`lib/rpc.ts` is an unscoped preload bridge: `invoke` forwards directly to
`window.ari.invoke`; `subscribe` invokes local `stream.subscribe` and
`stream.unsubscribe`. Changing which top-level view renders does not scope
these calls.

The existing safe remote path is:

`renderer remoteQuery/sendRemote -> machines.query/machines.command ->
registerMachinesRpc -> MachinesService -> GatewayClient -> remote gateway ->
RemoteHost`.

`machines-rpc.ts` has no Engine access. `packages/contracts/src/remote.ts`
defines strict command envelopes and the query allowlist. `machines.events`
is validated with `{machineId, sessionId, fromSeq?}` and emits
`{machineId, message: RemoteServerMessage}`. Late main-process subscription
results are checked against the current connection/subscription generation.
Preserve these boundaries rather than forwarding arbitrary local RPC names.

Public host capabilities indicate implementation support, not permission.
`machineCan` currently checks connected state plus advertised operation;
terminal controls must additionally require the authenticated `allowTerminal`
grant, and all operations still require host authorization/project checks.

Suggested renderer surface: a `SessionClient` with readonly `ref`, `uiKey`,
connection/authorization generation and `availability(action)` reason; typed
`query`, `dispatch` and `subscribe` for a finite session-method union; and
`pendingReceipt`/`checkReceipt` for original command status. Query DTOs can
normalize safe host projections for the normal components. `dispatch` accepts
only mapped session commands, validates that their wire target equals its bound
reference, and returns a discriminated confirmed/refused/unknown outcome.
Unknown retains the saved envelope. The local implementation explicitly uses
local RPC for its own scope; the remote implementation exhaustively translates
to named remote ops. A missing mapping returns an unavailable reason. Do not
accept arbitrary RpcMethod/Record<string,unknown> and fall through to local rpc.
Use the same client context in descendant transcript/model/file components;
machine account/catalog helpers may share its bound machine transport without
pretending account commands belong to the session receipt scope.

## Exact normal session RPC/action map

Paths in this table are relative to
`apps/desktop/src/renderer/src/`. Line locations refer to the inspected base.
“Missing” means absent from the current remote query/command schema, not an
invitation to call the local method.

| Caller / location | Current local method or command | Existing remote operation and shape | Gap / required handling |
| --- | --- | --- | --- |
| `features/session/SessionView.tsx:678`; `useSessionTitle.ts:32` | `session.load {sessionId}` | `session.get {sessionId}` -> `RemoteSessionResult` | Has Session, summary, seq, messages, pending items, optional tasks/parent. Does not provide local load's activeTurnId/providerSessionId/lastTurn. Add scoped desktop metadata or derive journal-owned context at the same barrier; do not manufacture an idle runtime. |
| `SessionView.tsx:490` | `session.tasks {sessionId}` -> `ChildTask[]` | `session.get.tasks` | Optional remoteChildTaskSchema projects child work, pending input/approval summaries and latest turn. Validate/default absence as unavailable, not a fabricated empty authoritative result. Does not include full orchestration result packages. |
| `SessionView.tsx:408` | `files.index {sessionId}` -> `{paths}` | `files.list {sessionId,path:'',cursor?,limit}` | Directory pagination is not an equivalent recursive @file index. Recommend bounded `files.index {sessionId,cursor?,limit}` returning relative paths, nextCursor and truncation; resolve root on host. Until supported, disable suggestions/host file references with a reason. |
| `SessionView.tsx:412,2150,2337`; `composer/ModelSelector.tsx:133` | `providers.models` | `models.list` -> `RemoteModelCatalog` | Map host catalog into presentation DTO; include source/defaultModelId, models/contextHint, efforts/modes. No local catalogs to fill unavailable remote data. |
| `ModelSelector.tsx:128,152` | `providers.detect`; `endpoints.list` | `models.list.providers` readiness and endpoint model IDs | Safe existing projection supplies installed/available/authStatus/reason and `ep:<hostEndpointId>:<modelId>`. Do not expose raw detection binary paths or endpoint URLs/keys. Respect host available flag even for ari-core. |
| `SessionView.tsx:2165` | `providers.efforts {kind,modelId}` | `models.efforts {driverKind,modelId}` -> `{efforts}` | Use selected host/model options. Old host absence means no unverified choice; never probe the client's provider. |
| `SessionView.tsx:997,1239` | `command.dispatch: turn.start {sessionId,text,attachments}` | `session.prompt {sessionId,text,attachmentIds?}` | Translate only validated attachment IDs. Explicit user Retry/Regenerate is a fresh prompt only after the prior submission is known; unknown submissions remain status-only. |
| `SessionView.tsx:1239` | `command.dispatch: message.enqueue` | `session.queue {sessionId,text,attachmentIds?}` | Same durable receipt and scope as prompt. An accepted queue is host state, not a local draft. |
| `SessionView.tsx:1362` | `command.dispatch: message.steer {text,attachments}` | `session.steer {sessionId,text}` | Text-only existing route. It explicitly maps to `attachments:[]` in remote-host.ts. Disable imaged queue steering until an attachmentIds extension resolves host/session/caller ownership. Never drop attachments. |
| `SessionView.tsx:1375,1390` | `command.dispatch: message.dequeue {text,attachments}` | Missing | Add `session.dequeue {sessionId,text,attachmentIds}` matching engine queue identity, or freeze host queue-entry IDs. Editing returns text to a separate recovery only after confirmed dequeue. Duplicate matching semantics must follow Engine, not renderer guessing. |
| `SessionView.tsx:1351` | `command.dispatch: turn.interrupt` | `session.interrupt {sessionId}` | Existing exact mapping; receipt belongs to the affected session. |
| `SessionView.tsx:1550` | `command.dispatch: session.update {driverKind,modelId,effort}` | `session.update` supports modelId/effort/permissionMode/title/pinned, **no driverKind** | A same-provider update must omit driverKind before strict wire validation. Empty-context provider changes need an explicitly validated driverKind extension or separate operation. No silent field stripping that changes the requested behavior. |
| `SessionView.tsx:1550` | `command.dispatch: session.provider.switch` | Missing | Recommend separate host-guarded operation with sessionId, driverKind, explicit modelId and effort reset; enforce canSwitchProvider, context/runtime rules, preserve session permissions. Running turn remains on its original provider. |
| `SessionView.tsx:1610,1625`; `useSessionTitle.ts:53` | `command.dispatch: session.update` effort/permission/title | `session.update {sessionId,effort?,permissionMode?,title?}` | Route every optimistic choice through the receipt client. Unknown failure must not create a new submission or certify host state; refresh after status reconciliation. |
| `SessionView.tsx:1466` | `command.dispatch: approval.respond` | `approval.respond {sessionId,approvalId,optionId}` | Normal ApprovalCard supports legacy coarse decisions. Remote answers must use the exact currently offered optionId; do not invent/map “always allow” to an ambiguous persistent grant. Unsupported legacy options stay disabled. |
| `SessionView.tsx:1486` | `command.dispatch: input.respond` | `input.respond {sessionId,inputId,value}` | Existing shape supports empty value for dismissal. An optimistic card hide must retain original answer/receipt and avoid a second submission after uncertainty. Refresh pending items on host reconciliation. |
| `SessionView.tsx:1657` | `orchestration.stop {sessionId,tree:true,idempotencyKey}` | Missing; `session.interrupt` stops one session only | Add one narrow durable tree-stop operation with host-selected descendants, relationship/project checks, `{requested,sessionIds}`. A child loop changes atomicity and receipt scope. Until supported disable tree stop; individual child Stop may use child-scoped interrupt and navigation. |
| `SessionView.tsx:1315`; `changes/CheckpointList.tsx:66` | `command.dispatch: checkpoint.revert {sessionId,turnId}` | Missing | Parent requires remote checkpoint revert disabled with explanation until a narrow, host-authenticated snapshot/checkpoint operation exists. Never call local revert. |
| `SessionView.tsx:644` | `git.turnDiff {sessionId,turnId}` | `changes.files/changes.diff` exist for current workspace comparison | Current workspace diff is not a per-turn checkpoint diff. Add bounded session+turn operation with host-resolved checkpoint endpoints or disable per-turn action/load with an explicit unavailable reason. |
| `transcript/TurnDiffFiles.tsx:30` | `git.turnDiffFile {sessionId,baseOid,headOid,path,oldPath?}` | Missing equivalent | Pin host-authorized checkpoint pair to session/turn, and bound relative file patch. Arbitrary client OIDs alone are insufficient authorization. Include in turn-diff capability; keep card visible when unavailable. |
| `session/PlanPanel.tsx:23` | `plan.get {sessionId}` -> `{items:null|[{text,status}]}` | Missing | Add narrow plan.get reading only host session plan filename, with bounds and jail/symlink checks; disable/mark unavailable until supported. Do not read a client .ari-todo file. |
| `session/use-turn-resume.ts:76,151,166` | `session.resume.get/schedule/cancel` | Missing | Read returns `{at:null|number}`; schedule at integer milliseconds and cancel are mutations with receipts. Scheduler runs on host only. Disable schedule/cancel until supported. |
| `use-turn-resume.ts:106`; `usage/use-provider-allowance.ts:80` | `providers.allowance {kind}` | `usage.allowance {driverKind}` | Map RemoteAllowance into view data without assuming local reset-credit identifiers. Use host timestamps. |
| `usage/use-provider-allowance.ts:162` | `providers.consumeResetCredit {kind,creditId}` | `usage.redeem {driverKind}` -> `{outcome,allowance}` | Host owns reset choice; new scarcity mutation gets one saved envelope. Do not transmit local creditId or retry unknown debit. |
| `providers/use-provider-accounts.ts:53,143` | `providers.accounts`; `providers.accounts.activate` | `accounts.list {driverKind}`; `accounts.activate {driverKind,accountId}` | Safe labels/slugs/plan/active state only. Account activation is machine/account scope rather than a session. Sign in/out/add/remove are disabled remotely; host must perform them. |
| `SessionView.tsx:1185`; `transcript/attachment-urls.ts:14` | `attachments.read {id}` | `attachments.read {sessionId,attachmentId}` | Add session scope to all thumbnail/check/read paths and cache keys. No image ID lookup through local RPC. Host returns bytes without local paths. |
| `composer/stage-images.ts:27` | `attachments.stage {files:[encoded...]}` | `attachments.stage {sessionId,files:[one raster image]}` | Existing host max 1 MB/image, one image/command, bounded staged count. Each stage command is receipted; sequence staging before prompt while preserving selected scope/draft. No local staging fallback. |
| `composer/Composer.tsx:598` | `fs.writeTextFile {sessionId,path:.ari/pastes/...,content}` | Missing | Keep pasted text inline (client draft only) until narrow `pastes.stage {sessionId,content}` creates a host-chosen jailed path and returns a relative reference. Do not expose generic fs.writeTextFile remotely. |
| Shell `App.tsx:542,1468`; session-start hooks | session update/archive/destroy/create | `session.update`; `session.archive`; `session.create {projectId,title?,driverKind?,modelId?,permissionMode?,effort?}` | Creation owns new-session receipt; archive uses explicit op. Destroy/unarchive/admin and workspace preparation are missing and disabled until matrix says otherwise. Shell owner handles these calls; SessionView adapter must not silently supply them. |

### Draft preparation and session creation: shell/host handoff

`shell/use-session-start.ts:144,156,172,192,207` currently uses local
dialog.pickFolder, project.open, session.workspace/checkOccupancy, session.update
for an empty-session reseed, and session.create. Local create supports `lead`
and workspaceMode auto/isolated/shared (`contracts/rpc.ts:235`); remote
session.create supports neither and `remote-host.ts:838-890` calls
engine.createSession directly, without the local prepareRootWorkspace path.
It does not establish branch/worktree draft parity merely by sharing an op name.

Remote draft preparation must use the chosen machine's project IDs, sanctioned
branch/worktree IDs and host occupancy information. No client folder picker,
project.open(path), local session.workspace, git checkout or root filesystem
fallback may run for it. Either extend one receipted host session.create with a
bounded workspace intent, or return a durable preparedWorkspaceId bound to
machine/project/client/draft and consume it through a separately receipted
creation command. The host owns branch resolution, repository membership,
occupancy/isolation, worktree creation and cleanup. Identity correlations from
the repository group never resolve the local clone as the host workspace.

Freeze `project.workspaceOptions` (read: projectId, bounded branch/worktree
identifiers/labels and reasons) and the exact create/prepare DTO with the shell
and host owners. This is a proposed capability, not a generic branch/path route.
Choosing a branch/worktree pins that draft's machine; Auto resolves once for the
draft and cannot migrate it after an uncertain prepare/create.

The local start hook's recovery permits “Start another session” after refreshing
the list. That local policy cannot recover a remote unknown create: list absence
is not proof of nonexecution. Remote creation must retain/check its original
new-session receipt. It must not re-run the start-hook closure or reuse an empty
session from a different host. The same rule applies to lead creation and
reseed/provider changes if those become supported.

## Streams: exact existing map and replay blocker

| Normal stream / owner | Existing remote stream/read | Required adaptation |
| --- | --- | --- |
| `session.events {sessionId}` in SessionView | `machines.events {machineId,sessionId,fromSeq?}` wrapping events.subscribe | Requires desktop full replay contract below; validate machine envelope and inner session/event IDs before folding. |
| `session.events {}` in use-session-activity and App | No machine-global stream. session.list / attention.list reads and per-session events exist. | Shell owner must maintain machine-scoped list/attention reads and subscriptions for visible/kept sessions, or add a narrowly scoped machine activity stream. Never subscribe to the client's global engine for remote activity. |
| `orchestration.changed {sessionId}` | No separate remote stream | Existing journal orchestration.* events can invalidate session.get.tasks where sufficient; full result packages still need a new capability. Avoid duplicated consumers and resubscription storms. |
| `providers.updates {}` in ModelSelector, effort/permission pickers, allowance/accounts | No remote provider stream | Refresh models.list/allowance/accounts on the selected host at picker open/reconnect/focus or a bounded host refresh policy. A local catalog event is not evidence of host changes. Add sanitized host invalidation stream only if matrix requires it. |
| `terminal.data {id}` | terminal.read `{sessionId,terminalId,fromSeq}` -> data/seq/reset/exited/hasMore | Narrow authenticated polling can feed normal terminal display. Creation/write/resize/kill use exact host IDs and receipts, allowTerminal/project checks. Never pass host cwd to local TerminalPane. Separate terminal owner required if activated. |
| `machines.updates {}` | Existing local registry view stream | Connection state can update availability/cache lifecycle. It is not host transcript data. |
| `scm.changed`, browser.updated, projects.changed | No equivalent generic remote streams | Not safe aliases. Safe session change reads exist; richer source-control/browser/admin actions are capability-disabled until a specific authorized remote operation exists. |

Direct gateway inspection (`packages/remote-gateway/src/gateway.ts:247-340`)
shows the mismatch:

- Without fromSeq, events.subscribe installs a live source and loads a snapshot
  only for authorization; it sends no full journal replay.
- With fromSeq, RemoteHost replays Engine journal events after that sequence.
  The gateway rejects more than 2,000 historical events as desync.
- `caughtUp:true` is attached only to the final nonempty replay event. Zero
  replay events produce no terminal. Existing frames carry neither
  replayOutcome nor runtime liveTurnId.
- Buffering during replay is already bounded (2,000 events / 4 MB), and every
  delivery re-checks active credential/project access. Retain those protections.

Normal `SessionView.tsx:537-633` buffers live events until its replay terminal,
deduplicates by journal seq, folds history without live side effects, handles
incomplete replay, and uses runtime liveTurnId to avoid resurrecting dead
execution. `history-journal.ts:40-51` prunes unobserved events only after a
complete authoritative full replay. A suffix-only replay marked complete
would incorrectly delete the cached prefix. Snapshot messages alone lose the
event context needed for usage, provider switches, background work and replay
control reconstruction.

Minimum proposed desktop contract, negotiated separately from mobile v1:

```ts
// Proposal only; host/contracts owner freezes actual names and schemas.
type DesktopSubscribe = { sessionId: string; fromSeq?: number }
// Absent fromSeq means full replay, including any seq 0.
type DesktopSessionFrame =
  | { sessionId: string; events: JournalEvent[]; replay: true;
      replayKind: 'full' | 'resume' }
  | { sessionId: string; replayDone: true;
      replayKind: 'full' | 'resume'; replayOutcome: 'complete' | 'incomplete';
      seq: number; liveTurnId: string | null }
  | { sessionId: string; event: JournalEvent }
```

The exact terminal high-water sequence/runtime sample and buffered-live
ordering must be documented as one consistent barrier. Always emit an explicit
authorized replay terminal for zero history and read failure; authentication
failure must instead send a refusal without unauthorized session metadata.
Bound frames/bytes and apply backpressure; do not impose a small total-history
cutoff. Resume preserves cached prefix. Desync/incomplete history leaves cached
content readable with a reason and a read-only resubscribe action. No history
failure retries a mutation. A metadata read can add the host Session plus
activeTurnId, provider-context presence/providerSessionId, lastTurn and seq,
or share those fields with a snapshot at this barrier. Do not infer runtime
liveness from projected turn.started.

## Capability-disabled controls and local device work

Parent's policy: preserve ordinary transcript cards and disable unsupported
controls with concrete reasons. The normal view must remain usable for supported
prompt/queue/stop/approval/question operations without mounting effects that
call unsupported/local RPCs.

`transcript/use-delegated-result.ts` calls orchestration.view and
orchestration.review/integrate/verify/retry; `DelegatedResultDiff.tsx` calls
orchestration.result.diff. None is in the current remote allowlist. Existing
changes.preview/integrate is the managed-worktree snapshot workflow, not the
same contract as accepting/versioning an orchestration result. Preserve child
activity/result summaries, but disable expanded review, integration,
verification, correction/retry and diff actions until separately negotiated.
If implemented later, require exact host session/task/result/attempt/version/
snapshot pins and status-only reconciliation for all mutations. The current
local delegated hook explicitly re-invokes captured mutation arguments on
Retry; that path must not be reused remotely.

Remote checkpoint revert, session destroy/unarchive/admin, arbitrary browser
control, provider sign-in/configuration, arbitrary file editing and generic
SCM commit/push/request controls likewise stay disabled with reasons. Safe
session-relative files.list/read and changes.files/diff may feed normal
read-only surfaces through scoped adapters. Opening an unrelated local folder
to fill missing host files is forbidden.

Composer OS non-image paste/drop currently calls osFilePath and inserts client
absolute paths (`Composer.tsx:559,651`). For remote sessions these cannot become
host file references. Accept explicit image bytes through host staging;
disable unsupported non-image drop/paste and use machine-scoped in-app drag
references with a verified same-host session/project scope. A filename alone
does not establish ownership. Browser picks captured by the client's browser
are not a host browser capability; arbitrary remote browser picking stays
disabled unless a separately authorized bridge defines its scope.

Clipboard text, selecting text, scrolling, focus, client draft edits and
notification preferences are client UI work. `useEngineSettings` may supply
the client's settle-sound preference but not host execution defaults.
`SpeechButton/useSpeech` currently use local speech.status/progress and the
local dictation lease. Do not accidentally mount provider/model transcription
as a remote execution fallback. Under the current no-local-provider rule,
disable remote speech unless the matrix explicitly defines client dictation
as an independent authorized input feature or adds host speech operations.

## Identity, caches, revoke and offline policy

Use a structural reference and an opaque renderer key:

```ts
type SessionRef = { machineId: string; sessionId: string }
const uiKey = JSON.stringify([ref.machineId, ref.sessionId])
```

The machineId is the authenticated registry's stable identity, never the
address, display name, git repository group or anonymous descriptor alone.
Give local sessions one explicit reserved namespace or trusted local machine
identity; do not interpret an unknown UI key as a local wire ID. Existing
remote-client.scopeKey already uses the collision-safe JSON tuple. During the
S1-safe transition, registry records are independently paired origin bindings;
do not collapse their IDs into public machineId without the parent/security
reviewed multiple-route trust contract. Provider endpoint IDs remain host-local.

Only adapters decode/bind a reference into an exact wire sessionId. Journal
events and `Message.sessionId` keep host IDs. Navigation callbacks from child/
parent cards reattach the same host, and validate host relationship/grants;
they never route a bare child ID through local App navigation. A repository
group correlates clones for choosing a draft machine, not moving a session.

Audit scope at all these locations:

| State | Current implementation | Required key / lifecycle |
| --- | --- | --- |
| Transcript | transcript-store.ts module Map keyed by bare sessionId, LRU 12; watched entries not evicted | Composite UI key while preserving wire IDs in messages; add targeted disposal that empties existing watched stores and invalidates writers, not just Map deletion. |
| Full journal | history-journal.ts WeakMap per TranscriptStore with sequence-keyed events | Inherits scoped store; dispose/invalidate journal on revoke/removal/trust change, retain prefix on resume. |
| Kept views | session-keep-alive.ts global 12 entries; SessionKeepAlive hiddenElements Map keyed by bare sessionId | Composite key in retention/dedup/React keys; reference-specific client remains captured for hidden views; targeted purge on revoke. Keep pool/space/pane identity distinct. |
| Composer draft/recovery | use-drafts.ts ari.drafts map; draft-recovery-store.ts module cache/persisted map | Composite UI key for text, images, picks, pending/recoveries, seeds and asynchronous generation checks. Preserve local legacy entries only as local, never infer remote ownership. |
| Existing remote draft/receipt | remote-drafts.ts and remote-client.ts machine+session keys | Reuse/migrate only exact known scope; preserve stored command keys and draft bytes. No migration that issues a fresh command. |
| Review notes / picks | review-drafts.ts sessionStorage/cache; browser-picks.ts draft-intent lookup | Composite key; same-host scoped relative reference, no cross-pane/client browser implicit attachment. |
| Attachment thumbnails | attachment-urls.ts module Promise cache keyed only by id | machine+session+attachment ID and authorization epoch. Invalidate null/error promises on explicit refresh; revoke any generated Blob URLs; ignore late bytes after disposal. |
| Catalog/allowance/accounts | RemoteConfiguration.tsx catalogCache Map keyed machine.id; local provider hooks may have singleton state | Machine identity plus authorization generation; sanitize data; avoid stale successful fetch replacing a newer host selection/revocation. |
| Default/model/effort choices | App.tsx defaultsBySession keyed sessionId; ModelSelector local state; last-pick.ts client singleton | Shell owns per-machine defaults and per-session composite keys. Existing session defaults hydrate from host only; draft machine change invalidates pending model/effort probes. |
| Split layout/navigation | split-layout.ts PaneLeaf.sessionId; spaces persisted in use-split-layout | Shell chooses structural ref or composite opaque key; retain offline remote panes rather than pruning them against a local session list. Every child/default/activity/title lookup uses composite identity. |
| Activity/attention | use-session-activity.ts global local event source and bare-ID maps/timers | Machine-scoped source and composite keys, including fade/ack/native-child maps. Offline is stale/unknown, not running or settled. |
| Result/turn diff UI | TurnDiffFiles/DelegatedResultDiff keys; useDelegatedResult receipt map | Composite session scope plus pinned snapshot/result/file; reject late results for another host/auth generation. Never reuse local retry closure. |
| Terminal references | local terminal-dock persisted IDs / TerminalPane cwd | machine+session+host terminal ID, authenticated grant/lease; no host cwd passed to local terminal.create. |

Proposed lifecycle policy, subject to parent's freeze:

- **Offline/reconnecting:** retain already fetched, bounded transcript/history
  and last-known labels under the same identity; show cached/read-only and last
  successful observation. Disable every host mutation and host file/provider
  fetch. Never certify cached running status or waiting approval as current.
  A pane can open its cached transcript without host calls. Current RemoteSession
  only retains snapshot state while mounted; it has no durable offline transcript
  cache. Existing normal transcript cache is memory-only. Across-app-restart
  offline transcript is a separate explicit storage decision, not already done.
- **Explicit revoke, unknown-device, identity mismatch, removal or lost project
  grant:** close subscriptions; invalidate authorization generations and pending
  writers; clear host-derived transcript, metadata, attachment, file/diff and
  provider caches for the affected machine/project. Clear visible watched stores
  too. Remove stale actionable approvals/questions. A compatibility/version
  mismatch can retain labelled cached data but grants no execution.
- **Drafts and unknown receipts:** preserve the user's draft and original
  submission evidence in its original scope. Revocation does not prove prior
  nonexecution, so it cannot discard the receipt or let Retry mint another key.
  An old receipt cannot be rebound to a new machine, origin or device after
  re-pairing; host status lookup is caller-bound. Parent must freeze any receipt
  ownership metadata required when credentials are replaced.
- **Route changes:** authenticated same-machine route reconnect preserves UI
  identity/cache only after core verifies the machine and credential binding.
  The renderer does not choose credential reuse. No credential is sent to an
  unverified address; retain exact origin binding and HTTPS downgrade prohibition.

No cache contains credentials; host tokens/key material remain in main's sealed
credential handling. Cached presentation data cannot act as authorization.

## Mutation recovery: preserve S1-S9

Use the existing remote-client.ts receipt semantics for every normal mutation,
including attachments, model/permission changes, account reset/activation,
child stop, queue edit, approvals/questions and future plan/result controls:

1. Persist the exact strict command envelope and original keys before dispatch.
   Storage failure prevents dispatch. Hold the action's affected scope, not
   whatever pane/machine becomes selected while awaiting staging/IPC.
2. Validate operation-specific success shape before clearing. session.fork and
   create return `{sessionId}`, not `{child}` or an arbitrary object. Update,
   prompt/queue/stop/input/approval expect accepted:true. Future contracts must
   define similarly unambiguous result/refusal DTOs.
3. Preserve the receipt after transport/IPC error, malformed success,
   internal_error, conflict, in-flight conflict or other uncertain failure.
   Only a known pre-dispatch guard refusal on the original submission, or an
   authoritative accepted:false/non-dispatch result, establishes nonexecution.
   Do not classify a thrown integration conflict as nonexecution (S9).
4. Reconcile saved commands through command.status with their original key.
   not_found/absent/expired status, unsupported/auth/revoked lookup and lookup
   connectivity failure do not prove the original command did not execute.
   Keep the original receipt and explain unknown outcome. Never reissue it,
   including legacy resolveReceipt(retry=true), composer recovery, Regenerate,
   generic invoke retry wrappers or delegated-result Retry.
5. Block overlapping mutations in the same receipt scope until reconciled.
   A child's operation/receipt belongs to the child (S7); preserve navigation
   to that affected same-host view. Prompt regeneration after a confirmed prior
   result is an explicit new user request, not uncertain delivery recovery.

The UI must not erase recoveries in `.finally()` or treat restoring text as
permission to send again when its command outcome is unknown. Pending status
belongs to the client state independent of whether the composer is focused,
hidden, remounted, split into another pane or moved offline.

The independent review's final S1-S9 disposition in
`docs/research/machines-security-review.md:513` is the baseline: origin identity
and credentials, lifecycle generations, shell lease, fail-closed persistence,
pinned unknown receipt retention, fork/child scope and exact worktree ownership
all remain required. This document adds no alternate filesystem/provider,
agent peer-link, pairing-approval or credentials path. Agent control of another
machine remains available only through an explicit authorized peer link.

## Concrete file ownership proposal

Only this research document was authored. The following is an implementation
boundary proposal for parent assignment, not permission to edit another owner's
files.

| Owner | Files / responsibility |
| --- | --- |
| Session routing owner after freeze | New `renderer/src/features/session/session-client.ts(x)` and scoped adapter tests; SessionView.tsx; useSessionTitle.ts; use-turn-resume.ts; PlanPanel.tsx; transcript-store.ts/history-journal.ts; SessionKeepAlive.tsx/session-keep-alive.ts. Convert reads/actions and distinct wire/UI identities, add read-only/capability states and receipt recovery. |
| Shared transcript integration, explicitly assigned | transcript/attachment-urls.ts and image consumers; TurnDiffFiles.tsx/TurnDiffCard.tsx; use-delegated-result.ts/DelegatedResult*.tsx. Obtain same client context and composite keys; unsupported controls visible/disabled, no local effect mounts. |
| Composer/model owner (separate) | Composer.tsx/ModelSelector.tsx/provider-readiness.ts; stage-images.ts; use-drafts.ts/draft-recovery-store.ts; drag-file.ts/browser-picks.ts/review-drafts.ts key plumbing; per-machine model/effort/permission data and machine picker. Session owner provides typed client/availability props; agree ownership before editing shared files. |
| Shell/sidebar/split owner (separate) | App.tsx; Sidebar.tsx/use-session-start.ts/NewSessionLauncher.tsx; split-layout/use-split-layout and space/pane lookup; use-session-activity.ts source; per-machine list/default/title/parent maps. Remove dedicated remoteTarget/RemoteWorkspace path and mount scoped normal SessionView in every pane. Never prune remote references from a local-only list. |
| Host/contracts/main owner (separate) | packages/contracts/src/remote.ts/machines.ts/rpc.ts and any new desktop DTO; remote-gateway/gateway.ts; remote-host.ts/host-remote.ts; machines.ts/machines-rpc.ts; replay/file/plan/resume/tree-stop/paste host facades. Auth/capability enforcement, host jail, receipts and replay barrier. No generic local-RPC forwarding. |
| Provider usage/accounts or terminal/files/changes owners if needed | usage/use-provider-allowance.ts/ProviderUsagePill.tsx; account hooks; TerminalPane/Dock; FileExplorer/Editor; ChangesView and SCM hooks. Consume scoped safe reads; disable unsupported management/mutations and prevent local cwd/root fallback. Separate explicit ownership before active work. |
| Design/matrix owner | docs/design/machines.md: parity rows, operation/capability in/out freeze and accepted identity/cache policy. |
| Existing machines UI retirement | RemoteSession/RemoteWorkspace/RemoteConfiguration/RemoteTools/remote-workspace.css are retired only after normal surface covers required behavior. Keep reusable remote-client receipt transport and exact scoped drafts; move/re-export deliberately with compatibility. |

## Validation handoff (not executed)

No builds, installs, tests, live app or real Serve were run. Research was verified
with direct source reads and rg inventories against contracts, remote host,
gateway, main registries and every identified normal session descendant.
The worktree began clean. Future necessary tests must use
`scripts/coordination/run-heavy.mjs`, the two-slot gate (dev already occupies one),
below-normal priority, one worker and no file parallelism.

Required meaningful regression coverage after implementation:

- Same wire session and image IDs on two hosts plus a local session: no shared
  draft, transcript, image, defaults, attention, pane or receipt data; inspect
  outgoing machine and exact wire IDs.
- Remote view mounts/hidden panes/offline cached view never invoke local
  engine/filesystem/provider methods. Unsupported capability controls stay
  visible with reasons and do not mount effects that invoke them.
- Empty and >2,000-event full histories, incomplete read, live/replay races,
  suffix reconnect, desync, remount, multiple panes and dead host turn: explicit
  terminal, no duplicate/gap/pruned prefix, no historical notifications or
  revived runtime.
- Accepted side effect followed by internal/conflict/IPC/malformed result,
  absent status, expired receipt, revoked status lookup and app reload: preserve
  key; Check status/Retry/Regenerate never resubmits unknown mutation.
- Model/effort/permission changes and image staging while switching panes/draft
  machine: original command target preserved, late response ignored by other
  scope; unsupported values not replaced by client defaults.
- Revocation/removal/project-grant loss invalidates hidden/watched caches and
  late fetches; offline cache remains readable only under its original scope;
  no shell after grant/lease loss.
- Fork navigation uses host `{sessionId}`, individual child Stop scopes child
  receipts, tree Stop uses host tree operation or is visibly disabled.

Remaining parent decisions: final DTO/op names and capability negotiation;
identity migration compatible with S1-safe origin binding; cache retention on
revocation and across restart; which narrow host operations land this run;
the speech input exception if any; exact shared-file ownership handoff.
