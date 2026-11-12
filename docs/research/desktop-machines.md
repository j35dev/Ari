# Desktop Machines implementation

Workstream D, branch `machines/desktop-ui`. Frozen design: `docs/design/machines.md`
in the coordinator checkout. Desktop renderer only; host/core/shared contracts
and the Mobile access page belong to other workers.

The implementation uses a dedicated remote workspace. Machine IDs accompany all
queries, mutations, stream parameters, drafts, staged images, and uncertain
receipts. Remote paths never reach desktop filesystem or command dispatch RPCs.
Terminal visibility requires the authenticated `MachineView.allowTerminal` grant.

Verification will use focused desktop suites, the shared atomic heavy runner,
and deterministic temporary browser fixtures. No saved settings, paired devices,
running Ari, Tailscale configuration, pushes, or PRs are changed.

Baseline and final results are recorded below when available.

Baseline: SettingsWorkspace and NewSessionLauncher, 2 suites / 18 tests passed
under the shared runner on 2026-11-11. Shared contracts/client commits consumed:
`fa7dd3a9`, `6ffb3874d789344d6d847a808b7af2d3e52f4c87` (cherry-picked).

## Visible changes

- Settings has a searchable Machines entry under Connections. Manual tailnet URL
  and pairing-link entry, bounded discovery, host confirmation codes, pairing
  status/expiry, rename, reconnect, incompatible/legacy identity labels, terminal
  grant labels, and explicit removal confirmation are present. Hosting links to
  the existing Mobile access page; that page is unchanged by this workstream.
- The sessions sidebar lists remote computers separately, with host project and
  session names. New-session entry chooses a computer before projects. The host
  creation form uses that host's model catalog, permissions and effort options.
- The dedicated remote workspace labels its host throughout and offers history,
  resumable events, prompt/queue/steer/stop, image staging/reading, exact provider
  approval options, the existing full question UI, child/parent navigation,
  child interruption, session rename/pin/model/mode/effort, fork and archive.
- Host tools include workspace-relative file navigation/previews, change lists
  and text diffs, snapshot-bound parent integration preview/confirmation, and a
  separate xterm terminal visible only with the authenticated device grant.
- Transcript following preserves manual scrollback. Session composer drafts and
  creation project/title/provider/model/mode/effort drafts persist per machine.
  Actions save exact commands and receipt keys before IPC. Unknown transport,
  IPC, internal-error, conflict and malformed-success outcomes remain blocked
  until explicitly checked/retried on the originating host. Child stop receipts
  belong to the child and link back to its workspace for reconciliation.

## Dedicated workspace differences

The remote workspace has one host session per view and its own sidebar/tools.
It does not put host session IDs or paths into the local pane/split/space,
filesystem, browser, git-control or terminal-dock systems. The local workspace
stays mounted and returns through **This computer**. While remote work is
selected, local titlebar tools, command palette/search and local pane shortcuts
are suppressed; native window controls remain available.

Queue submission is supported and receipt-confirmed. The remote session result
does not expose the queued-message contents, and the allowlist has no queue
edit/remove/reorder commands. Consequently this view cannot show or edit a host
queue; it does not invent a queue from locally submitted prompts. Remote file
previews are read-only, with binary/size-limit states. Diff selection shows one
host file at a time. Provider login/key configuration and host settings remain
host-owned. This workspace does not expose provider-account management or device
administration panels. Removed or revoked hosts cannot use granted terminal UI.

## Verification and runtime

Resolved session: **codex / gpt-6.1-sol**, inherited effort **xhigh**, permission
mode **full**, confirmed with the caller fields returned by `ari env`. No child
agents were launched. Every heavy step used the shared atomic runner, D caches
and temporary directory, one test worker and no file parallelism. No OOM/killed
step occurred. Source authoring and all generated artifacts stayed in this D
worktree. Wide integrated checks and hardware/managed-Connect checks belong to
the coordinator and are not claimed here.

Before the final security adjustments, 9 focused suites / 51 tests passed.
The next changed-boundary run passed 4 suites / 20 tests, including the named
internal-error/in-flight receipt regressions and local-shell shortcut isolation.
Renderer-only typechecking passed before the final fork/child-link adjustments.
Initial lint findings were corrected; final checks and captures follow below.

## Fresh takeover, 2026-11-12

Sole worker resumed the clean `machines/desktop-ui` worktree at `92d29b6b`.
Reviewed the actual branch history, renderer, coordinator resume/handoff notes
and the independent security report. The S2 named-failure receipt policy and S7
fork/child-scope corrections are present; final execution evidence is pending.
The assigned caller resolves to codex / gpt-6.1-sol, xhigh, full permissions.
No additional workers, live profile changes, push or PR will be used.

This WIP preserves the review checkpoint before coordinated heavy validation.
