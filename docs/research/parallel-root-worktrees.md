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
one serialized admission check and journal barrier across roots. The cross-root
gate covers starts, enqueues and human answers; awaited provider steering,
checkpoint work, execution and disposal remain outside it. Provider work remains
parallel. A released folder retries blocked queues across root trees.

Root creation uses the existing durable workspace preparation receipts. Unknown
checkout/creation results preserve the exact identity and are never automatically
repeated after reload. Root destruction uses the existing owned-worktree release
queue, bounded cleanup checks, and restart retries. Aria can explicitly destroy
an unconfirmed root from its own preserved launch receipt; archived callers and
lower permission caps still refuse cleanup. Only Ari-owned paths, refs, and
session-specific branches are removed. Session list, composer and Changes show
managed worktree labels and paths. Reusing a pristine human session first checks
the same server occupancy policy; an occupied folder goes through new-root
acquisition instead of reviving that session in place.

## Verification

All install/test/format/lint/typecheck/build work uses the unchanged shared
`D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs` runner. It acquires
`D:/Projects/Ari-machines-wt/.heavy.lock`, checks C free space and commit headroom,
uses D caches/temp, and bounds Vitest to one worker with file parallelism off.
WIP was committed before long steps.

Main baseline: 54 passing tests in agent-control, workspace and managed-workspaces.
Changed engine: 108 passing tests in helm, agent-control and workspace; 49 more
availability, preamble and launch-option cases passed in their focused run.

Desktop: 265 distinct tests passed across focused runs, including engine,
recovery, session creation, CLI parsing, source control, sidebar, new-session
chooser, review workspace and first-session composer. The final source changes
were followed by 43 passing tests in root-concurrency and App.first-session:

- Two isolated top-level roots run together with uncommitted files snapshotted.
- Same physical folder startup races accept exactly one root, including aliases.
- A slow provider steering response does not hold up an independent root.
- Aria and human new sessions automatically isolate alongside busy code work.
- Shared-folder and busy non-Git/unborn-repository starts refuse clearly.
- Spawn receipts/workspaces survive reload, with no duplicate effect on retries.
- Unconfirmed-root destruction respects caller permission caps and retries safely.
- Shared descendants occupy the actual folder; its release restarts held queues.
- Resuming a long human wait rechecks occupancy before provider response.
- A busy pristine composer session uses new-root acquisition; free reuse persists.

Final focused ESLint and typecheck passed through the same shared lease. The
focused type config includes changed files, their imports, existing DOM test
setup and asset declarations. `git diff --check 6f018a75` passed. Formatting ran
through the heavy runner. No killed/OOM step occurred. Only fixtures/configuration
were corrected after initial failing checks; all final checks above passed.

UI evidence is deterministic DOM testing. No browser capture, running Ari,
paired device or production profile was used; live narrow-layout/screenshots and
wide build/suite validation remain with the parent. Labels reflect a session's
declared worktree; shared descendants inherit the physical workspace at runtime.

Reproduce the final focused checks under the shared runner using:

```powershell
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs "Build parallel sessions" "D:/Projects/Ari-machines-wt/concurrency" -- node C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs exec node scripts/coordination/validate-parallel-root.mjs C:/Users/user/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs
```

## Independent integration notes

Read the Machines concurrency context and the Aria lead measurement. The latter
was also inspected at immutable commit `f2591c40` after its external worktree path
became unavailable. This change keeps lead/context/report/delegation behavior.

`feat/aria-experiment` (`f2591c40`) overlaps engine dispatch, agent-runtime turn
safety, rpc engine configuration and agent-control imports/scoped control. Keep
its off-by-default experiment guards before ordinary admission, including
runtime refresh and provider release; do not replace them with folder checks.
A `git merge-tree --write-tree --name-only` dry merge against immutable
`f2591c40` confirmed content conflicts only in `apps/desktop/src/main/engine.ts`
and `apps/desktop/src/main/agent-runtime.ts`. RPC and control service merged
automatically. This wrote no branch or working files.
`d7399052` (neutral dictation indicator) has no file overlap. Nothing was merged
or written in the experiment worktree. The parent should run the final wide
checks/build on the integrated branch; this fix remains an independent branch while the coordinator also integrates its commits into
`feat/machines` (2026-11-12 takeover instruction supersedes the old exclusion).

## Fresh independent review, 2026-11-12

Starting tree: `89b22dbd`, clean; standalone base remains `6f018a75`.
Reviewed physical folder admission, root acquisition, start races, inherited
shared workspaces, approval/input resume, non-Git/unborn repositories, uncertain
receipts, owned cleanup/restart retries, permission ceilings, CLI/human creation
and the declared-worktree UI labels against source and focused regressions.

Found and fixed a missing recovery case: `projects.ask` can now acquire a root
worktree, but the durable error handler previously merged computed checkout
identity only for `session.spawn`. A lost checkout acknowledgement on the lead
path kept its session ID while losing the path/branch. Both methods now preserve
that identity and permission ceiling through retries and reload; explicit cleanup
still requires the original caller's receipt and current permission cap. The
regression exercises both methods against real temporary Git repositories and a
fake provider. The final source tree (`3be07c1e`) passed scoped ESLint and
typecheck, plus all 44 focused desktop tests. Its five focused engine suites
reported 136 passes and one incorrect fixture assertion: `ari/child` contains
the complete ID `child`, so exact-ID legacy compatibility correctly accepts
it. `d1422ebe` corrects only that expectation; the three ownership unit tests
then passed. This is 137 distinct passing engine cases across the focused
runs, including both actual colliding-root cleanup cases. No production source
changed after those checks. No killed/OOM step occurred.

The coordinator supplied PR refs after this review started: 514 is
`df66c4ed`, 515 is `64050689`, 516 is `d7399052` (including `f2591c40`).
Read-only file comparison finds no overlap with 514/515; 516 overlaps engine,
runtime, rpc and control service as in the prior immutable review. Preserve
its off-by-default experiment guards. No fetch, push, PR or live Ari changes.
Registered uncertain
human-created worktrees remain inspectable; human `session.create` lacks the
Aria caller's durable operation receipt and does not automatically clean an
unconfirmed registered checkout. Shared descendants resolve the inherited cwd
correctly; current labels report declared ownership, so descendants declaring
`project` do not get their parent's Worktree badge. Those existing UI/recovery
limits are explicit and do not relax folder admission or cleanup ownership.

The security reviewer also identified unsafe legacy cleanup ownership: short
eight-character keys collide between human roots sharing a timestamp prefix.
New branches use the SHA-256 digest of the full exact session ID, including a
marker that distinguishes the new key from legacy title slugs. Cleanup accepts
that complete key (and numbered collisions), or legacy branches whose full
final path component equals the exact session ID. Ambiguous legacy short-key
branches are preserved for inspection, never deleted by a guessed owner. This
can leave legacy branches behind after directory/ref cleanup. A real Git
regression creates another root's unique, unintegrated commit, unregisters its
checkout, and proves both current and legacy-short branches survive cleanup
and a fresh manager while exact legacy full-ID cleanup still succeeds.

Security reproduction IDs: `sess_mabcd123a_aaaaaa` and
`sess_mabcd123a_bbbbbb`; the legacy shared ownership key was `mabcd123`. The
regression confirms another root's unregistered branch and its unique commit
remain intact under current and legacy-short naming, including numbered branch
suffixes. Exact full-ID legacy branches for the cleanup target are removed,
while full-ID branches for the other root remain. Prior owned cleanup tests
also passed, including failed-removal restart retries, external junction targets
and unrelated/sibling paths. The coordinator is receiving the corrected proof
for independent security re-review before integration.

Review commits before final evidence: `a26861db`, `77f9422d`, `5c7f359e`,
`f76359ce`, `3be07c1e`, `d1422ebe`. Changed files: `agent-control.ts`,
`root-concurrency.test.ts`, `git/orchestration-branch.ts` and its unit test,
`git/managed-workspaces.test.ts`, this handoff, `parallel-root-typecheck.json`
and `scripts/coordination/validate-parallel-root.mjs`. No broad suite, build or
browser capture was run. The standalone branch remains based on main
`6f018a75`; integration into `feat/machines` belongs to the coordinator.
