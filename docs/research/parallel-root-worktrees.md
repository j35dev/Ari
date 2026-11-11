# Parallel root project sessions

Branch: `fix/parallel-project-worktrees`, based only on main `6f018a75`.
Worker: codex / gpt-6.1-sol, resolved effort xhigh, permission mode full.
No Machines commits, pushes, PRs, live Ari/settings changes, or Tailscale changes.

## Behavior

A new root session uses its project folder while free. When occupied, human
creation and Aria `session spawn --project` acquire a managed worktree through the
same policy. Explicit `--workspace isolated` always isolates; `--workspace shared`
requires the project folder and refuses when occupied. Isolation snapshots staged,
unstaged and non-ignored untracked files without changing the source HEAD/index.
Busy non-Git folders and repositories without a commit fail clearly.

Occupancy follows each running session's effective physical folder, including
shared descendants, nested folders, Windows case rules and junction/symlink
aliases. Independent worktrees in the same project run concurrently. Stale
journal turns and pending reports do not count; the existing three-minute human
wait rule remains. A human answer must reacquire the folder before resuming a
parked provider. Existing tree follow-ups can queue, but all actual starts use
one serialized admission check and journal barrier across roots. Provider work
remains parallel. A released folder retries blocked queues across root trees.

Root creation uses the existing durable workspace preparation receipts. Unknown
checkout/creation results preserve the exact identity and are never automatically
repeated after reload. Root destruction uses the existing owned-worktree release
queue, bounded cleanup checks, and restart retries. Aria can explicitly destroy
an unconfirmed root from its own preserved launch receipt; archived callers and
lower permission caps still refuse cleanup. Only Ari-owned paths, refs, and
session-specific branches are removed. Session list, composer and Changes show
managed worktree labels and paths.

## Verification

All install/test/format/lint/typecheck/build work uses the unchanged shared
`D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs` runner. It acquires
`D:/Projects/Ari-machines-wt/.heavy.lock`, checks C free space and commit headroom,
uses D caches/temp, and bounds Vitest to one worker with file parallelism off.
WIP was committed before long steps.

Main baseline: 54 passing tests in agent-control, workspace and managed-workspaces.
Changed engine: 108 passing tests in helm, agent-control and workspace; another
49 availability, preamble and launch-option tests passed in the preceding run.
The initial real-engine integration run passed five cases; its one failure was a
Windows fixture line-ending expectation, corrected with fixture-local
core.autocrlf=false. Final desktop and check results follow below when complete.

## Independent integration notes

Read the Machines concurrency context and the Aria lead measurement. The latter
was also inspected at immutable commit `f2591c40` after its external worktree path
became unavailable. This change keeps lead/context/report/delegation behavior.

`feat/aria-experiment` (`f2591c40`) overlaps engine dispatch, agent-runtime turn
safety, rpc engine configuration and agent-control imports/scoped control. Keep
its off-by-default experiment guards before ordinary admission, including
runtime refresh and provider release; do not replace them with folder checks.
`d7399052` (neutral dictation indicator) has no file overlap. Nothing was merged
or written in the experiment worktree. The parent should run the final wide
checks/build on the independently integrated branch; this fix stays separate
from `feat/machines`.
