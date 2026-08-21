# AGENTS.md — Operating Protocol for Ari Builders

This file governs every agent (human or AI) working on Ari. It is binding.

## Project in one line

Ari is a cross-platform (Win/mac/Linux) Electron + React + TypeScript desktop ADE that
drives locally-installed coding agents through their native JSON protocols, plus a built-in
harness for custom endpoints. Read `PLAN.md` for the full architecture before your first
task.

## Golden rules

1. **One task = one commit.** Never accumulate multiple tasks in one commit.
2. **`pnpm verify` green before every commit.** No exceptions. If the tree is red, fix it
   or revert; never leave it red.
3. **No placeholder code.** Every function you commit must be real and tested. `TODO`
   comments are allowed only for genuinely deferred *scope*, marked `// TODO(mXX.Y):`.
4. **Never touch** `pnpm-lock.yaml`, root `package.json`, `.github/`, or another agent's
   in-flight files. Dependency changes are orchestrator-only.
5. **Small diffs.** Target ≤ ~400 changed lines per commit. Split a task rather than grow a
   diff.
6. **Match existing style.** Read neighboring code before writing. Mimic conventions.
7. **Comments only where they earn their place** — JSDoc on exported public APIs; inline
   only for non-obvious invariants. No narration comments.

## Resume ritual (start of every session)

1. Read `PROGRESS.md`. Find the first unticked task assigned to you (or unassigned if you
   are picking freely).
2. Read that task's spec section in `PLAN.md`.
3. `git fetch origin && git rebase origin/main` on your branch.
4. Work the task. Tick the box in `PROGRESS.md` **in the same commit** as the work.

## Task workflow

```
git checkout -b <type>/m<milestone>.<task>-<slug>     # e.g. feat/m1.4-button
  … implement …
pnpm verify                                            # must be green
git add -A && git commit                               # conventional message
git push -u origin <branch>
gh pr create --fill                                    # small PR, self-review first
```

- Branch types: `feat|fix|chore|docs|test|refactor|perf`.
- Commit message: `<type>(<area>): <imperative summary>` — areas: `ui, engine, providers,
  core, desktop, contracts, shared, docs, build`.
- PR body: what changed, why, how verified (paste `pnpm verify` tail). Link the task id
  (`M1.4`) at the top.

## Definition of Done

- [ ] `pnpm verify` green (typecheck + lint + tests)
- [ ] Feature runs via `pnpm dev` (or unit-proven where UI can't run headless)
- [ ] Tests added/updated for all new logic paths
- [ ] `PROGRESS.md` checkbox ticked in the same commit
- [ ] If architecture shifted: note added to `docs/arch-<milestone>.md`

## Blocked protocol

After **two** failed attempts at an approach: stop. Record in `PROGRESS.md › Blockers`
(task id, what you tried, error essence), open a draft PR with `[blocked]` prefix
describing the state, pick the next independent task. Never leave `main` broken and never
force-push shared branches.

## Code conventions

- TypeScript strict, ESM (`"type": "module"`), no default exports except React components
  and electron entry points.
- Workspace imports are narrow subpaths: `@ari/shared/jsonl`, not `@ari/shared`.
- Files: components `PascalCase.tsx`; everything else `kebab-case.ts`. One primary export
  per module.
- Validation: zod schemas live in `@ari/contracts`; parse, don't validate twice.
- Errors: typed `Result` from `@ari/shared/result` for expected failures; throw only for
  bugs. Never swallow errors silently — log via `@ari/shared/logger`.
- Async: no floating promises (`no-floating-promises` is on); use `AbortSignal` for
  cancellable flows.
- Styling: Tailwind utilities referencing design tokens only (`bg-surface-1`, not
  `bg-neutral-900`). Raw hex/oklch literals belong exclusively in `packages/ui/tokens.css`.

## Verify commands

```sh
pnpm verify        # typecheck + lint + test (all packages) — required pre-commit
pnpm dev           # launch desktop app in dev mode
pnpm test:watch    # vitest watch
pnpm format        # prettier write
```

## Fleet notes (orchestrator-managed workers)

- Claim a task by writing `(claimed @ <branch>)` next to its line in PROGRESS.md before
  starting; remove when merged.
- Workers must not merge their own PRs. Orchestrator reviews and merges.
- If two tasks touch the same directory, they are dependent by definition — take one, not
  both.
