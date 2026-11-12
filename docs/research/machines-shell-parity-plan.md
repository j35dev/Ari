# Machines shell parity architecture and contract requests

Status: research only, 2026-11-12. Base `db9f8d85`, branch
`machines/shell-rework`, worktree `D:/Projects/Ari-machines-wt/shell-rework`.
No runtime contracts are frozen by this document. No code, install, test, build,
dev app, user checkout, installed launcher, Mobile access or Serve change is made.

Controlling inputs are [the parity matrix](../design/machines.md), the latest
desktop Aria `machines-t3-parity.md`, and the parent's live corrections. This
replaces the old dedicated remote-workspace direction. The matrix's linked
`docs/research/machines-parity-contracts.md` is absent in this checkout at this
base; the routes/design worker has been asked for its current proposal.

## Outcome and ownership

One normal sidebar repository entry correlates clones. A new project draft uses
the normal Composer/ComposerDock chrome with a machine selector below its plate.
The first durable session is created on first send, after host, checkout, catalog
choices and any branch/worktree selection are frozen. Existing sessions use the
normal SessionView with immutable host/project/session scope and no selector.
Routes affect transport only. Grouping, preference and Auto confer no authority.

The parent agreed to first-send creation during this research turn. The shell
worker owns the project draft surface and its lifecycle; the normal-session
worker owns existing-session SessionView, its routed facade and view internals.
No fake durable ID or synthetic `session.load` is used for a draft.

| File/component seam | Shell ownership / requested dependency |
| --- | --- |
| `App.tsx` | Remove `remoteTarget`, RemoteWorkspace branches, RemoteMachineGroups, MachineChooser and local/remote chooser state. Integrate scoped navigation, repository groups, draft panes, start focus and existing SessionView scope supplied by facade worker. Audit shell action callbacks before admitting remote entries. |
| `shell/Sidebar.tsx` | Accept correlated repository groups and scoped session rows; machine label/status on rows; preserve tree, search, inbox, selection, keyboard and split behavior. Project-group actions select a concrete checkout before host actions. |
| `shell/NewSessionLauncher.tsx` | Choose repository/project draft, not create a durable session. Preserve keyboard/search/Lead behavior; same-host duplicate clones require a checkout choice. Local Add project retains local folder workflow. |
| `shell/use-session-start.ts` | Freeze scoped attempt on actual submit, preserve F occupancy/reuse and intent safeguards, reconcile uncertain creation on original host only. Creation and first prompt have separately tracked outcomes. |
| `features/welcome/WelcomePanel.tsx` + new project draft component | Own draft branch using normal Composer/ComposerDock. Setup-only panel stays distinct so its raw local provider/endpoint checks do not mount for a remote project draft. |
| `features/composer/Composer.tsx` | Only optional `machineSelector?: React.ReactNode` below-plate slot and its layout/accessibility. Shell does not edit normal send/queue/attachment logic. |
| `features/machines/*` | Provider, inventory hooks, grouping, selector, draft choice state, preferences/cache adapters, reason/status display and focused tests. Extract inventory out of RemoteMachineGroups before deleting that UI. Preserve shared safe remote transport/receipt utilities pending facade migration. |
| `features/settings/MachinesSettings.tsx` | Outbound Add/rename/status/version/update guidance, Routes, Your permissions and Auto/preferences. Incoming device approval remains Mobile access. |
| `features/session/SessionView.tsx`, split/Changes/files/terminal internals | Normal-session worker owns immutable scope threading, normal tool facade, replay, draft-key consumers and capability degradation. Shell imports these seams; no concurrent edits. |
| contracts/main/gateway/registry/package/lockfile | Core/metadata worker owns typed wire and persistence contracts, authenticated catalogs/resources/repository metadata and actual two-host proof. |

`ComposerDock.tsx` is reused without editing its internals. The displayed empty
Aria SessionView composer is not a project draft and must not gain a machine
selector. The actual WelcomePanel is setup-only today; it has no Composer.

## Current evidence and replacement risks

- `App.tsx:163` owns `remoteTarget`; `:1060` calls useSessionStart; `:1375`
  renders RemoteWorkspace, `:1507` renders separate RemoteMachineGroups,
  `:1698` renders normal SessionView, and `:1872` renders MachineChooser.
- `use-session-start.ts` currently performs local folder/project open, finds an
  empty session, checks `session.workspace(checkOccupancy: true)` before reseed,
  then calls local `session.create` eagerly. Unconfirmed create blocks starts
  until list check and explicit Start another. Keep these safeguards at submit.
- `WelcomePanel.tsx` directly uses local `providers.detect/rescan`,
  `endpoints.list` and `endpoints.upsert`. Its endpoint save preserves identity
  after lost acknowledgment; the remote draft branch cannot reuse those checks.
- `use-machines.tsx` tracks saved MachineView and revisions, but `machineCan`
  checks public capabilities plus connected status. That is insufficient to
  establish project/provider authorization or effective action grants.
- `RemoteMachineGroups.tsx` owns a module-local inventory cache and polls
  authorized project/session lists. Cache retention is memory-only and must move
  into the shared provider with profile scope, revisions and explicit deletion.
- `Sidebar`/`session-nav` and App callbacks assume raw local session/project IDs.
  App currently prunes panes against the local session list. Adding remote rows
  alone would create ID collisions, local dispatch and offline-pane deletion.
- `remote-client.ts` has machine-scoped receipts and status-only recovery;
  `remote-drafts.ts` has machine/session drafts and machine-scoped creation draft.
  Replacing remote UI must preserve unresolved receipts and staged attachments.
- `composer/last-pick.ts` currently remembers one global local provider/model/
  effort. Remote catalogs need host-specific picks; local endpoint IDs cannot
  seed remote model selections merely because their strings match.

## Desired typed boundaries for the freeze

The names below are proposals, not new wire contracts. Final names, schemas,
operation names and ownership must come from the parent/owners before code.

### Immutable UI scope and facade (normal-session worker)

Require a host-scoped `SessionUiScope` and explicit helper-produced UI keys.
Each durable scope carries stable host ID, client saved-machine ID when remote,
host-local project ID and actual host-local session ID. Route IDs/origins are
not session identity. Local scope is explicit, never an omitted-target fallback.

Navigation entries carry `{ uiKey, scope, summary }`. A normal SessionSummary
remains host data; grouping keys must not overwrite its `projectId`, and UI keys
must not be passed to raw RPC as session IDs. The facade owns any reversible
projection needed by existing string-keyed pane/tree/activity helpers. Bind
parent/child IDs to the same host; do not parse arbitrary keys in shell callbacks.

Need exact exported module and signatures for: scope/key creation and lookup;
scoped session inventory/update/destroy/workspace/occupancy; capability reasons;
safe host catalog and project defaults; and creation/first-send/attachment/status
operations. Existing SessionView accepts immutable scope, and the shell receives
created scope rather than just a raw string. Facade normalizes genuine history
and events; shell never fabricates replay or tunnels arbitrary desktop RPC.

The project draft has a separate client-local ID/revision and selected concrete
host/project. Its composer uses that draft key without loading a fake session.
Need attachment staging ownership and transfer rules: no attachment path from
one host may be reused on another. Draft-to-created-session handoff preserves
text/files and exact first-send receipt; a lost first-send acknowledgment after
confirmed creation never triggers a second create.

### Authenticated inventory/catalog/resources (metadata worker)

Require local and remote inventory through the same typed adapter. A snapshot
identifies its host/client-machine, generation/revision and authenticated grant
context; project and session records retain their concrete owner. Distinguish
loading/error/stale snapshot from successful authoritative absence/removal.
Last-known authorized inventory remains usable for offline navigation, never
for selecting a disconnected host for new work.

Repository metadata supplies `canonicalKey`, chosen remote metadata, optional
`origin.canonicalKey`/redacted label and identity status. Host resolves network
fetch remotes and normalization; renderer consumes keys, never Git URLs or remote
filesystem discovery. Require explicit known-no-network-remote versus enrichment
pending/failure. Checkout display is host-authorized, safe to transmit and
distinct enough for duplicate clones; project ID remains the actual selection.

Catalog supplies provider/driver/model IDs, installed/authenticated/usable state,
supported effort levels, permission modes/ceilings, and host/project defaults.
Do not expose binary paths, endpoint credentials or generic local detection.
Use selected-host choices and validate remembered choices against its fresh
catalog. Invalid choices surface a required new choice or the host's documented
default, never another machine's provider/default.

Resources supplies authenticated aggregate CPU usage percent, CPU count,
available memory bytes and total memory bytes. Require finite values, positive
count/total and bounded percent/available. Freshness uses validated client
receipt time on a monotonic clock (15 seconds), not remote wall-clock trust.
Restored samples cannot become fresh after app restart. Snapshot grant/catalog
revisions permit final send revalidation independently of sampling.

### Client-local persistence (core storage + shell adapters)

Parent reports a proposed `machines.preferences` settings API/registry including
This PC and each host. Require exact read/update operations, revision handling,
profile namespace and ownership. Auto defaults off; per-machine initial Normal;
preferences are Prefer/Normal/Less often/Manual only. They affect Auto only.

Persist safe inventory cache and draft choice separately from authority. A draft
records ID/revision, repository group, explicit host/checkout, manual/Auto mode,
resolved Auto host/reason, branch/worktree lock and host catalog selections.
Remember last machine/project choice; a missing/ineligible remembered host
requires explicit resolution, not silent substitution. Fresh drafts default to
This PC before any remembered choice exists. Storage failure loses convenience
only unless durable submission/attachment recovery would be lost: then block
dispatch and retain the current draft in memory with a clear status.

Receipts use profile + immutable host + project/session-or-draft + operation/key
scope, preserve exact payload/fingerprint, and are durable before dispatch.
Never invent unscoped localStorage receipt keys or drop old receipts on regrouping.
Legacy migration maps only known exact saved-machine/session identity and keeps
ambiguous/corrupt/unresolved records visible for recovery. No guessed migration.
Forget/remove purges only the selected scope and closes its clients; route edits
do not purge session/draft identity. Credentials stay in existing sealed storage,
never preferences/cache. Cached permissions/resources do not grant action access.

### Machines status/routes/permissions (routes/design + core)

Require MachineView extensions for stable route IDs/order/kind/provenance/source,
current route and per-route readiness; authenticated host identity/protocol/Ari
release; installation/update support/manual instructions; and effective current
permissions/project scope/terminal/operation grants/ceilings/expiry.

Operations needed: saved-machine list/update stream, Add/pair/status/connect/
rename/forget; authenticated Add route, reorder and remove saved route; current
Your permissions read. Learned routes reorder but cannot be removed. Removing
the final route uses explicit forget-machine flow; removing a source also removes
dependent learned routes as core authority dictates. UI never associates a new
origin using a matching public ID, and never sends credentials itself.

Permission display names the route in use. Offline display is explicitly
last-known; other routes are not probed by opening the permissions tab. Version
incompatibility remains in sidebar/settings with a named host/update path.
Optional unsupported operations are disabled with reasons. Update guidance is
safe host metadata; no shell command updater or provider install action is added
to the draft/catalog UI. Production LAN use stays disabled by default.

## Grouping and normal sidebar behavior

Group key is `origin.canonicalKey ?? canonicalKey`; display prefers origin label.
Canonical identity follows upstream when available, but a fork groups by its
origin. No usable network remote remains keyed to `(hostId, projectId)`. Name,
path, basename and public machine ID never merge repository groups or grants.

Two clones with one grouping key on one host appear in one repository group
but are distinct checkout candidates. No arbitrary first candidate, recency or
basename inference. A remembered exact checkout may be retained only after
current eligibility is validated. Auto excludes unresolved checkout ambiguity
rather than choosing a physical folder.

One group contains normal session rows with machine labels, immutable keys and
host-local parent/child trees. Offline/incompatible entries remain selectable
read-only with reconnect/update reasons. Enrichment can regroup presentation
without changing an open draft/session's scope. Local prune runs cannot remove
remote panes because a remote inventory is temporarily unavailable.

Group header New session opens a draft. Project Reveal/Locate/Import/Close/
Remove are capabilities on one concrete checkout; a correlation group has no
host filesystem target. Batch session actions partition by actual scope and
retain per-host outcomes, never fan a raw local call over remote IDs. Keyboard
navigation/search, activity, drag/split and pane title lookups use facade keys.
No unsupported remote action calls local RPC. Shell-owned raw dispatch points
must be audited together with normal worker-owned tool internals.

## Draft, Auto and submit state machine

1. New session/project pick creates only a client draft and preserves its pane/
   space focus intent. Project selection resolves eligible checkout candidates.
2. Manual selector offers This PC and only compatible, connected, authorized
   hosts with that project and usable catalog. Offline hosts remain in sidebar
   and Machines settings. Manual only preference does not disable manual choice.
3. Auto appears only after opt-in. Only an unresolved Auto draft requests
   resources. Eligibility requires current host grant/project/provider, explicit
   checkout and fresh authenticated sample; CPU <95%, available/total >5%.
   Weights are 100/50/25/0. Score is weight x CPU idle fraction x available memory
   fraction x CPU count. Stable host ordering breaks ties. Missing samples/all
   busy/no eligible candidates require manual choice; no local fallback.
4. Resolving Auto records concrete host/project/reason once. Inventory, resource,
   route, preference updates and rerenders do not resample. Explicitly reselecting
   Auto starts a new resolution revision; stale results cannot win. Host/branch/
   worktree selection fixes host. A locked branch/worktree is not silently moved.
5. Explicit manual host switch is allowed only for an editable unlocked draft
   with no uncertain create/first-send and no unreconciled host-staged files.
   Host catalog selection updates explicitly; old provider credentials/endpoint
   references/attachments are never copied across hosts.
6. On Send, freeze attempt/revision/catalog choices and revalidate authorization,
   project/provider/permission ceiling on that host. Eligibility loss reports a
   reason and retains selected host; it does not rerun Auto. Check physical-root
   occupancy before empty-session reuse/reseed and acquire F isolated worktree
   on busy Git root through host operations, without client filesystem inference.
7. Persist exact create receipt before dispatch. Confirm actual `sessionId`
   shape, hand off immutable scope and first prompt once. Existing-session reuse
   preserves that session's host and uses host-validated setup before send.
8. Unknown creation locks original host, checkout, payload and key. Check status/
   refresh that host only. Absence/conflict/malformed success/IPC uncertainty do
   not imply permission to resend. Explicit Start another is a new user action,
   after inspection, with a new draft/key; never replay the uncertain mutation.
9. Confirmed creation permanently fixes host, removes selector and routes normal
   session actions through scoped facade. Creation success and prompt uncertainty
   are separate; read-only reconcile preserves whichever operation is unresolved.

Auto provider eligibility/model constraints and receipt payload types still need
exact freeze. In particular Auto must not silently replace a requested provider
because another host's catalog differs. Host catalog is authoritative at send.

## Planned verification after contract freeze

This research runs no tests/builds. Implementation will first add focused
meaningful coverage, then use the parent's affected checks and integrated proof.

| Area | Required regression evidence |
| --- | --- |
| Grouping | SSH/HTTPS canonical clones, upstream/origin forks, unknown/local remotes, enrichment failure, duplicate same-host checkouts, no name/path merge and identical raw IDs on two hosts. |
| Draft/Auto | This PC first default, remembered exact host/project, off by default, four preferences, finite/fresh authenticated samples, all busy/missing -> manual, stable ties, rerender/route refresh no resample, reselect revision fencing, branch/worktree/attachment/uncertain locks. |
| Host catalog | Selected host models/efforts/modes/defaults, denied/incompatible/provider unavailable, stale grant revalidation; no remote local provider detection/endpoint lookup or install/update mutation. |
| Starts/F | Existing App.first-session, session-start-focus/runtime and launcher keyboard behavior adapted to first send; occupancy before reseed, isolated busy Git root, cancellation/unmount/focus elsewhere, unknown create/status-only and confirmed-create/unconfirmed-first-send separation. |
| Normal shell | One repository group with two hosts, offline retained, scoped children/activity/search/batch actions/panes, no prune on list error, selector absent on existing and Aria sessions, supported normal controls through shared facade and disabled unsupported controls. |
| Machines | Outbound only, rename/status/version guidance, saved/learned route reorder/removal/final forget, current-route Your permissions, last-known offline, no reverse/group/transitive or public descriptor authority. |
| Persistence | Profile/host/draft/session collision isolation, exact migration, corrupt/ambiguous receipt retention, storage failure before dispatch, forgetting exact host and resource freshness after restart. |

Screenshots after implementation: selector/default/Auto/manual reason and locks;
one-repository/two-host sidebar including offline/incompatible; remote normal
session; Machines Add/status/version/Routes/Your permissions; light and dark.
Use disposable profiles and sanitized mocked catalogs with no pairing secrets.
Provider install/update controls affect global binaries and must stay inert in
fixtures. Do not touch the observed live dev app or real Serve.

Heavy work, once authorized, uses `scripts/coordination/run-heavy.mjs` at
below-normal priority, one worker, no file parallelism. Dev takes one of two
slots; require C: >=5 GiB and commit headroom >=1.5 GiB, second slot only >=6 GiB
headroom. No install/tests/build until parent hands freeze. No push or PR.

## Coordination sent and outstanding freeze items

Contract requests were sent directly to normal-session facade worker
`sess_8e7f19d7-0de1-44e9-ad9a-6a1437497872`, host metadata worker
`sess_bad8972b-a32d-47ea-a593-e704760b7575`, and routes/design worker
`sess_e899c63b-aaa7-4c6f-9ea0-f8d89359aeb9`. Parent accepted first-send lifecycle
and shell draft ownership, and requested safe client-local persistence/reasons.

Before code: freeze exact scope/key exports and existing SessionView prop seam;
typed draft prepare/create/first-send/attachment/reconcile APIs; inventory/
repository enrichment and checkout types; safe catalog/resources/freshness and
Auto provider constraint; preferences/cache/draft store/receipt migration; route/
permission/update operations; and App navigation/Changes/terminal overlap with
normal worker. No wire operation is invented or assumed available by this plan.
