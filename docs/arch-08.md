# arch-08 — Checkpoints, diffs, and revert

## Git service

`packages/engine/src/git/git-service.ts` wraps the `git` subprocess (no
libgit2) with 10s timeouts and porcelain v2 parsing. All methods return
`Result<T, GitError>` from `@ari/shared/result`.

## Checkpoints

Each turn is bracketed by a **hidden git ref** `refs/ari/<sessionId>/<turnId>`
captured at turn start via `captureCheckpoint`. The engine calls this before
spawning any adapter; failures are non-fatal (checkpoints are best-effort and
silently skipped outside repos).

Storage GC caps refs per session (`pruneCheckpoints`) so long-running
sessions don't accumulate unbounded refs (M8.10).

## Revert flow

1. Renderer dispatches `checkpoint.revert {sessionId, turnId}`.
2. Decider verifies a captured checkpoint exists for that turn; emits
   `checkpoint.reverted`.
3. Engine executes `GitService.revertToRef` — workspace files restore to the
   checkpointed tree. Conversation history is preserved (revert restores
   code, not chat).

## Diff viewing

`git diff <ref>` output flows through the unified-diff parser
(`features/diffs/parseDiff.ts`) into virtualized file cards with per-file
collapse and add/del gutters. The Changes rail shows worktree-vs-HEAD for the
first registered project; per-turn diffs arrive from checkpoint refs.

## Non-git degradation

Sessions against non-repo folders skip checkpoints silently. The Changes rail
surfaces "not a git repository" instead of an error.
