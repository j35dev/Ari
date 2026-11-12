# Machines shell parity implementation

2026-11-12. Branch `machines/shell-rework`, worktree
`D:/Projects/Ari-machines-wt/shell-rework`. This implementation supersedes the
research-only proposals preserved in commit `3ee700f5`. The accepted
[coordinator freeze](machines-parity-contracts.md) controls exact ownership and
renderer seams; the latest Machines brief controls product behavior.

Pairing remains one-way. Machines settings manages outbound computers; incoming
approvals remain in Mobile access. There are no machine groups, reverse
approval, transitive grants, session migration, automatic cloning or execution
fallback to another computer. S1–S9 in [the security review](machines-security-review.md)
remain unchanged. Shell changes do not certify route cryptography or real-host
execution; those proofs belong to the coordinator and respective owners.

## Implemented renderer seams

- `App` combines host inventories with local projects/sessions into one normal
  sidebar. Repository group keys use `origin.canonicalKey ?? canonicalKey`.
  Different fork origins stay separate; missing identities remain scoped to
  exact host/project IDs. Same-host clones retain distinct checkout IDs and
  require explicit selection. Only exclusively remote projects show a host
  label on their header; sessions show small host/status labels.
- `sessionViewKey(SessionScope)` provides local keys and exact remote
  `[registryMachineId, wireSessionId]` keys. The shell never sends these remote
  presentation keys through privileged local session/workspace actions. Child
  and parent metadata passed into normal SessionView retain wire IDs; callbacks
  return view keys exactly once. Offline pane references survive list refreshes.
- Normal Files, Changes, titlebar SCM and terminal overlays mount the session
  owner's `SessionClientProvider` with their owning scope. A split terminal
  targets its requested pane/session, resolves that local session's workspace
  or uses the remote relative root, and checks the immutable target again after
  awaiting a local workspace. Terminal owner/binding internals are coordinator-owned.
- Remote archive/deletion, offline edits and unsupported content search are
  disabled. Concrete local project actions map back to the sole local checkout;
  correlation-group IDs have no filesystem authority.
- `MachineChooser`, `RemoteMachineGroups`, `RemoteWorkspace` and `remoteTarget`
  are removed. Original transport, receipt and remote draft helpers are retained
  for recovery and migration; their old receipts are not discarded.

## Draft creation and recovery

Project selection opens a client project draft using normal `Composer` and
`ComposerDock`. It creates no durable session and does not load a fake session.
The picker appears below controls only in a new project draft. Existing sessions
and Aria do not show it.

`ModelSelector.hostCatalog` is undefined for its established local behavior,
null while remote metadata loads, or the selected host's safe catalog. Supplied
catalogs suppress local provider detection, endpoints lookup, subscriptions and
bundled-model fallback. The selected host supplies models, supported efforts,
permission modes and defaults. An unavailable saved choice requires a valid
choice before sending.

The draft registry persists the group snapshot and original pane/space. A
separate choice record retains manual/Auto mode, stable host/reason, checkout,
catalog selection and branch/worktree lock. Original text/image bytes use the
normal Composer draft stores. Files remain client-local until creation/staging.
Choosing a branch/worktree or starting an uncertain creation/staging attempt
locks host selection across reloads.

First Send persists the exact attempt before dispatch, freezes host/project/pick,
and revalidates that original host. Local creation invokes preserved
`useSessionStart.createDraft` only at Send, retaining F occupancy/reuse and busy
root isolation. Remote creation always uses `createHostDraftClient`; it never
falls back to local. Successful creation returns an immutable SessionScope.
Staging and prompt submission revalidate the same host and never reselect Auto.

Unknown creation is status-only. Missing/conflicting receipts and uncertain
acknowledgements do not authorize retry. Confirmed creation followed by an
uncertain first prompt never creates or prompts again; repeated checks inspect
the original receipt. Uncertain staging can open the created normal session only
after original text/image intent is transferred; the original host receipt stays
in its scoped receipt helper. Local draft creation recovery also exposes only a
list/status check, without a hidden second-create toast action.

Confirmed completion places the session in its original pane only while that
draft still owns the blank pane. Parking, switching spaces, choosing another
session or replacing a draft does not let a late completion replace current
content or steal focus. The confirmed session remains available in its host's
normal inventory. Handoff clears only the completed draft's stores.

## Auto policy and freshness

Auto is available in the picker and off by default. This PC is the initial manual
host; an eligible last manual host is remembered per repository. Preferences are
Prefer, Normal, Less often and Manual only, with Normal initially. Manual only
excludes Auto while remaining manually selectable. Settings shows preferences
and Auto only when at least two connected, compatible hosts have usable catalogs
and current permission metadata, counting This PC when its catalog is usable.

`machine-policy.ts` defines the tested thresholds:

- Resources must be authenticated live reads with finite positive timestamps,
  no future sample and age at most **30 seconds**. CPU must be in `[0, 1]`;
  memory must be finite, total positive and available within `[0, total]`.
- A host is busy at **85% CPU or above**, below **1.5 GiB available memory**, or
  below **10% available/total memory**. Busy or missing/stale resources require
  manual selection. Auto never silently queues work.
- Among nonbusy connected/compatible hosts with this repository and a usable
  catalog, preference tier comes first, then CPU ascending, available memory
  descending and literal registry ID ascending as the deterministic tie-break.

The host and reason remain stable through inventory, routes and resource updates.
Selecting Auto again recomputes once. Send checks the originally resolved host;
eligibility loss retains that selection and reports the reason. Resources are
memory-only and not restored from storage, so an app restart cannot make old
samples fresh. Restored Auto choices still require a fresh sample before Send.

Inventories are bounded by host schemas. Offline/incompatible presentation may
retain last-known projects/sessions, while catalog/permissions/resources failures
block new work. Explicit revoke/removal/public-identity mismatch purges the
presentation. Synchronous generations fence both successful and failed late
requests so an old transport cannot restore revoked data.

## Verification and integration

The first focused shell run passed 123/124 tests: draft UI, Auto, grouping,
ModelSelector no-local-probes, sidebar, launcher and settings. Its sole old
settings expectation was migrated from an always-visible rename field to the
Rename → Save name action. New integrated inventory/sidebar tests cover merged
rows, distinct raw IDs across hosts, forks, offline selection, revoked late-read
fences and public identity replacement. Further affected checks are recorded in
the handoff commits and coordinator's final evidence.

`testing/machines.tsx` now mounts normal SessionView, normal merged Sidebar,
ProjectDraftPane and Machines settings with strict fake metadata and desktop
replay. `packaging/capture-machines.mjs` records light/dark draft/Auto, normal
session, status-only receipt, routes/permissions and merged offline sidebar.
It opens a hidden isolated D: profile and refuses external endpoints and
mutations. These captures are component evidence; the final integrated app and
actual two-host proof remain coordinator release gates.

All authored code/install/build activity remains in the assigned D: worktree.
Heavy checks use the shared below-normal lease runner, one test worker and no
file parallelism. No installed profile, real host, Serve/Tailscale settings,
protected fix branch, user UI-dev worktree, push or PR is changed.
