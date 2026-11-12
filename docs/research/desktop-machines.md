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
  until checked on the originating host. Saved actions are never resent, even
  when an old host returns `not_found` after receipt loss. Child stop receipts
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

The coordinator's S6 follow-up removes receipt resubmission entirely. All saved
action, creation and terminal controls perform read-only status checks. Missing
results retain the exact receipt and explain that the outcome is unknown;
the legacy `retry=true` call cannot invoke `machines.command`.

## Composer correction takeover, 2026-11-12

The sole replacement worker resumes `5a3a71e7`; `ari env` confirms
codex / gpt-6.1-sol, **high** effort, **full** permissions. This supersedes the
earlier worker's xhigh runtime only for this final correction. No workers were
delegated. The existing untracked painted captures are preserved in this WIP
before coordinated validation. Prior focused test/type/lint successes were
reported by the coordinator; their raw logs are absent from this worktree's
`out` directories, so fresh affected checks are recorded separately below.

The composer replaces native Choose File/No File Chosen chrome with the Ari
**Attach image** Button and ImagePlus icon. It opens the hidden file input with
the existing accessible label and retains its validation, limits, host/session
scope and pending-action disablement. Only workspace and receipt captures will
be refreshed in light/dark; approved settings and sidebar evidence is preserved.

## Final correction verification and integration handoff

New commits after the assigned `5a3a71e7` checkpoint:

- `95683428`: preserve the corrected composer and all ten previously untracked
  painted PNGs plus capture metadata before heavy work. This commit retains the
  original native-picker screenshots as the before evidence in Git history.
- `fb68823b`: format the focused capture option and attachment-control assertions.
- `c8f71c46`: record the four refreshed PNGs, combined check transcript and this
  completed handoff. Code validated is `fb68823b`; subsequent changes are
  evidence/documentation only.

Every command below used the coordinator prefix:

```text
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs TITLE D:/Projects/Ari-machines-wt/desktop -- node C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs
```

| Title                            | pnpm arguments                                                                                                                                                                                  | Result                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `desktop-composer-format`        | `exec prettier --write apps/desktop/src/renderer/src/features/machines/RemoteSession.tsx apps/desktop/packaging/capture-machines.mjs docs/research/desktop-machines.md`                         | Passed; committed formatting before tests                                           |
| `desktop-composer-tests`         | `--filter @ari/desktop exec vitest run src/renderer/src/features/machines/RemoteSession.test.tsx src/renderer/src/features/machines/remote-client.test.ts --maxWorkers=1 --no-file-parallelism` | 2 suites / 28 tests passed, 17.79 seconds                                           |
| `desktop-composer-types`         | `--filter @ari/desktop exec tsc --noEmit -p tsconfig.machines.json`                                                                                                                             | Passed                                                                              |
| `desktop-composer-lint`          | `exec eslint apps/desktop/src/renderer/src/features/machines/RemoteSession.tsx apps/desktop/packaging/capture-machines.mjs`                                                                     | Passed                                                                              |
| `desktop-composer-fixture-build` | `--filter @ari/desktop exec vite build --config machines-fixture.config.ts`                                                                                                                     | Passed, 14.70 seconds; Vite reported its large-chunk warning                        |
| `desktop-composer-capture`       | `--filter @ari/desktop exec electron packaging/capture-machines.mjs --composer-only`                                                                                                            | Passed; four changed screenshots, no renderer console errors or horizontal overflow |

The original fresh-check logs are in `out/desktop-composer-*.log`; their complete
contents are preserved as `docs/research/evidence/desktop-machines/verification.txt`
for integration and eventual worktree removal. No install, wide test/lint/build,
live Ari, device settings, Tailscale, other worktree, push or PR was used. Every
runner admission passed the resource gate; no killed/OOM step, provider mismatch
or retry loop occurred. The session runtime is codex / gpt-6.1-sol, high, full.
Node is v24.13.0. Final handoff formatting also passed through the coordinator
runner (`desktop-composer-final-format`, `exec prettier --write
docs/research/desktop-machines.md`) and is included in the preserved transcript.

Captures use real renderer components with fake RPC, a hidden offscreen Electron
43.4.1 / Chromium 150.0.7871.224 window, a temporary D-worktree profile and a
nonpersistent partition. External network requests are blocked. Requested window
size is 1440×1100; measured viewport/paint size is 1440×1020 at scale 1. The four
updated files are `machines-workspace-light.png`, `machines-workspace-dark.png`,
`machines-receipt-light.png` and `machines-receipt-dark.png`. All four were visually
inspected: the attachment icon/text is readable, aligned with the other composer
controls and correctly dimmed when an action is uncertain. The six approved
settings/sidebar PNGs are byte-for-byte unchanged from `95683428`, and their
metadata is retained. `capture.json` also records the hidden input's original
label, hidden decorative icon and matching button/input enabled or pending states.

Security findings for this correction: no new issue identified. The existing
late-staging test proves that a delayed upload result stays in its originating
machine/session draft. The receipt suite passes the old-host `not_found` and
legacy `retry=true` regressions: the exact receipt is retained, and controls only
query `command.status`. Both receipt captures deliberately check the old-host
missing-result fixture; no `machines.command` occurs and no retry control is
visible. No core/shared contract or credential code was edited.

The dedicated workspace limitations listed above remain: one remote host session
per view, separate host tools instead of local panes, read-only host previews,
one selected diff at a time, no host queue editing or provider/device settings.
The native OS picker was not driven by automation; component uploads exercise the
existing labelled input and staging path. Integrated wide checks, two-computer/
iPhone tailnet behavior, sleep/network transitions, secure-key restart and live
managed Connect remain coordinator/hardware release gates. This branch is ready
for coordinator review/integration; the coordinator can remove this worker and
D-worktree after accepting the integration.
