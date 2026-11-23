# Qoder native subagents

The production Qoder SDK adapter now exposes native framework agents through Ari's existing Claude subagent presentation. This addition preserves the prior SDK migration and Qoder/Pi streaming fixes; Pi remains on ACP.

## Confirmed behavior and changes

- `packages/providers/src/qoder/mapper.ts` maps streamed `Agent`/`Task` calls and native lifecycle messages through the shared tracker in `packages/providers/src/claude/background-tasks.ts`. It captures prompts, type, reported model, progress and final results. Foreground launch receipts do not prematurely complete a known native task; the parent's result does not terminate background agents.
- Native IDs are kept separately from launch-call IDs. Explicit late binding joins provisional records and removes duplicate cards, retaining earlier child output. No labels or ordering heuristics determine identity. The optional `nativeTaskId` is journaled by the engine and preserved by the shared projection.
- `QoderDriver` targets native IDs with `stopTask`, identifies child approvals even when the permission callback precedes event parsing, keeps child callbacks live after parent completion and advertises child inspection capability.
- `SessionView`, `SubagentRow`, `ChildSessionActivity` and `SubagentView` reuse Ari's current components with provider-specific labels. Opening a launch alias resolves the canonical child. Stream chunks reconcile before child narration is assembled, preventing split words and duplicate snapshots.
- The journal projection preserves a running child's approval across parent settlement; the session view preserves it across replay's idle parent boundary. Terminal child reports clear its approval. Parent requests retain their existing settlement behavior.

## Run the review

From the worktree root:

```powershell
pnpm --filter @ari/desktop exec vite --config streaming-fixture.config.ts
```

Open <http://127.0.0.1:5317/testing/subagents-fixed.html>. The page runs the production **SessionView**, native cards, child transcript, approvals, composer and history folding against synthetic journal events. It refuses unrelated RPCs and never starts a provider, daemon, command or file operation.

Use **Replay/Pause**, **Reset**, **Parallel work**, **Child approval**, or **Results & failure**. Open an agent row or the child-session rail. Expand the activity group to inspect all eight synthetic reads and intermediate narration. The failed child contains an expandable exact synthetic command and output. Stop changes only the fixture's task states. Approval choices affect only the synthetic replay.

The prior actual-component streaming regression remains at `/testing/streaming-fixed.html`; the full before/after mockups remain at `/testing/streaming.html` and `/testing/streaming-v2.html`.

## PNGs and provenance

These are screenshots of the actual preview in Ari's in-app browser at its available **800×600** viewport, saved as PNG from the browser's JPEG capture. They contain synthetic prompts, paths and output. They are not captured provider transcripts. The earlier full-size 1592×897 before/after PNGs remain in the parent review directories.

- [Parent with two Qoder agents](previews/01-parent-800x600.png)
- [Child with compact activity](previews/02-child-activity-800x600.png)
- [Failed child with command/output expanded](previews/03-failure-800x600.png)

Verified visually: parent cards, Qoder child labels, prompt, compact activity, expandable detail, red failure state, exact command/output and the narrower layout. Replay advanced from frame 0 to frame 2; Pause stopped it; Reset returned to 0; Stop changed both cards and child-rail rows to stopped. The child approval and its exact requester were verified in component/replay tests; browser snapshots do not enumerate controls inside Ari's protected shadow-root approval UI.

## Tests and live limits

Verification reports are under `apps/desktop/out/`:

| Report | Passed | Skipped | Scope |
| --- | ---: | ---: | --- |
| `subagent-provider-tests.json` | 894 | 3 | Full provider suite, including Qoder/Claude/native tasks |
| `subagent-contract-tests.json` | 314 | 0 | Full contracts suite |
| `subagent-ui-tests.json` | 67 | 1 | Affected transcript, child UI, history and engine subagent tests |
| `subagent-replay-tests.json` | 18 | 0 | Additional native approval, settlement and replay regression checks |
| `subagent-projection-tests.json` | 59 | 0 | Shared journal projection and dispatcher |

The reports overlap and should not be added into one total. Workspace typecheck, targeted type-aware lint, the desktop production build, the standalone fixture build and `git diff --check` passed. Build chunk-size advisories remain.

The opt-in smoke now accepts `--subagent`:

```powershell
pnpm --filter @ari/desktop exec vite build --ssr src/main/testing/qoder-sdk.smoke.ts --outDir out/sdk-smoke --emptyOutDir
node apps/desktop/out/sdk-smoke/qoder-sdk.smoke.js "C:/Users/user/.qoder/bin/qodercli/qodercli.exe" --subagent
```

It registers one no-tools child, permits only the parent `Agent` tool, uses an empty scratch workspace with configuration sources disabled, bounds turns/time and prints verification booleans and envelope shapes rather than content or reasoning. A real CLI **1.1.95**, SDK **1.0.60** run passed: one native task completed, exact child and parent replies, prompt recorded, no errors. The child model field was absent and remains blank. Background cancellation, parallel work and approvals were exercised with fixtures; a live background/parallel task capture is still unverified. Native Stop status depends on SDK lifecycle messages.

The installed Ari coordinator was not restarted. Changes were developed and verified in the isolated worktree; review and merge status are tracked in the GitHub PR.
