# Ari orchestration implementation

Implemented in `feat/orchestration-workflows`, based on [the pinned t3code comparison](ari-t3code-orchestration-2026-11-07.md). These are source changes and production build outputs. The running Ari 0.3.10 executable has not been replaced or restarted.

## Resulting behavior

| Area                 | Implemented behavior                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider ownership   | Codex app-server notifications are correlated before mapper state changes. Native child completion cannot terminate root execution, overwrite resume identity, or enter root text and usage meters. Child approvals retain exact thread/turn/item/request identity.                |
| Conversation         | Elevated Team card removed from PlanPanel. Compact status, reserved Work trigger and optional Tasks/Decisions/Results/Messages inspector. Composer draft remains mounted.                                                                                                          |
| Status and decisions | Shared desktop/mobile completion and attention vocabulary. Requests preserve human/lead ownership and exact provider choices. Live responses and steering depend on the created adapter.                                                                                           |
| Coordination         | Durable recipient inbox replaces assignment queues for session messages. Reciprocal cooperative waits wake on incoming notes or direct-child lead questions. Explicit acknowledgement separates delivery from consumption. The inspector never acknowledges on behalf of an agent. |
| Assignments          | Typed goals, roles, acceptance criteria, owned paths and dependencies. Isolated worktrees by default, concrete shared-write overlap checks and complete brief validation before workspace/session effects.                                                                         |
| Dependencies         | Current code results must be integrated; report-only results must be accepted. Dispatch materializes prerequisite code and records exact versions plus bounded summaries. New attempts invalidate superseded prerequisites.                                                        |
| Results              | Immutable versions with summary, files, issues, snapshots and check provenance. Review, acceptance and integration are distinct. Integration requires a current accepted exact snapshot. Unavailable code snapshots cannot masquerade as report-only results.                      |
| Corrections          | Recorded review feedback feeds an explicit retry. Finished-task follow-ups start another attempt. Uncertain submissions recover through an explicit new session. Active coordination retains observable delivery state.                                                            |
| Context              | Selected bounded messages/files/accepted outputs with preview. Edits and late replies cannot replace newer selections. Received packages and prerequisites can be inspected per attempt. Portable fork/provider transfers start explicit new sessions.                             |
| Comparison           | Models use isolated attempts on a frozen common base. Side-by-side comparison pins result versions and shows snapshots, check provenance and issues. New results never silently replace selected versions.                                                                         |
| Routines             | Typed RPCs reuse the durable scheduler, freeze relative timing across same-key retries and retain five-minute minimum repeats. No real routine was created during development.                                                                                                     |
| Recovery             | Journal-backed mutation receipts, identity-based delivery/acknowledgement reconciliation and uncertain outcomes without blind provider/Git replay. Prepared worktrees survive ambiguous journal failures.                                                                          |
| CLI input            | UTF-8 multiline text through `--prompt-file`; orchestration JSON through `--params-file`. Bounded input, mutually exclusive with inline text.                                                                                                                                      |
| Interaction          | Stable rows, successful history folded, failures/corrections visible, narrow modal focus handling, draft preservation and reduced motion. Coalesced family streams and stable accessibility announcements.                                                                         |

## Validation

Desktop and mobile production builds passed. Workspace typechecks and lint passed; final changed-file lint, desktop typecheck and desktop rebuild also passed. Package coverage below totals **4,553 passing checks and four skipped checks**, combining full runs with the affected-suite reruns rather than claiming one uninterrupted clean run.

| Package        | Passing checks | Notes                                                                                  |
| -------------- | -------------: | -------------------------------------------------------------------------------------- |
| Contracts      |            107 | Full suite                                                                             |
| Shared         |             15 | Full suite                                                                             |
| UI             |            261 | Full suite                                                                             |
| Engine         |            397 | Full coverage with serial Git reruns; includes the shared-junction cleanup regression  |
| Providers      |            607 | One additional check skipped                                                           |
| Remote gateway |            160 | Full suite                                                                             |
| Ari Core       |            279 | Full suite, serial rerun                                                               |
| Mobile         |            279 | Full coverage with corrected Result ready label expectation                            |
| Desktop        |           2448 | 268 files covered through the full run and affected-suite reruns; three checks skipped |

The initial broad run hit Windows Git/test-hook timeouts and subsequent fixture cleanup errors. The affected Git suites passed serially; the conflict fixture also passed separately. Worker cleanup exposed Git for Windows following dependency junctions. Cleanup now checks the resolved managed path and detaches links before deletion; dependencies were fully restored offline from the unchanged frozen lockfile. A temporary Vite module-cache failure in the parallel Ari Core run cleared on its serial rerun.

Desktop's full run recorded 2,443 passes, five failures and three skips. Those five failed checks now pass: renderer IPC channels derive from the shared RPC catalog, the narrow Work drawer uses the shared overlay tokens, the approval fixture declares live support and awaits disposal, and journal/Git fixtures have bounded I/O/setup waits and explicit journal closure. IPC sender validation remains unchanged. The final affected-suite runs also covered Work panel interaction and the complete checkpoint/background fixtures.

Focused integrated checks include 59 task/inbox/wait/supervisor tests, 35 updated task/inbox checks and 22 interface/CLI checks. Provider lifecycle validation previously passed 607 tests with one skipped. Regression fixtures cover native child/root interleaving, reciprocal waits, origin identity, lost delivery/acknowledgement outcomes, superseded prerequisites, real Git visibility, pre-effect size refusal, exact snapshot review/integration, prepared-workspace receipt failure, bounded project-scoped inboxes and literal multiline CLI file input.

Actual Work components were inspected in Ari's browser at wide/narrow widths, including decisions, comparison, reserved header and Messages. Tests cover fifteen active tasks plus 100 folded historical tasks. Temporary previews, aliases and servers were removed. No live-worker performance benchmark was performed.

## Practical limits

- Independent snapshot verification runs read-only `git diff --check`. Worker-reported tests remain separate evidence.
- Live delivery requires provider support. Other transports check inboxes between meaningful chunks and during cooperative waits. Idle-agent notes remain in the inbox; an explicit assignment/follow-up starts work.
- Ambiguous queues predating inbox identities are preserved for manual handling. Uncertain effects require inspection and explicit recovery; recovery does not automatically delete orphans.
- Unsupported provider-native fork/message/stop/reconnect controls remain disabled. Portable handoffs do not copy hidden provider history.
- No live prompts, real schedules, deployment or installed-app replacement. No t3code parity, reliability percentage or speed improvement is claimed.

Mutation barriers and recovery rules: [orchestration-recovery.md](../../packages/engine/src/orchestration-recovery.md).
