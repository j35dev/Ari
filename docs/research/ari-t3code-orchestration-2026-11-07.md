**Ari orchestration compared with t3code — research and improvement plan**

Research date: 7 November 2026. Ari checkout: `69d032b7857843902a57f05ed9c0726994d5f562`. t3code checkout: `0f4a13071090e89c6d7eccdb0eb98b3cde1823ee`. The running Ari control surface reported version 0.3.10; its installed build was not proven identical to this checkout. Source links below pin the revisions examined.

The main conclusion is that Ari has a substantial orchestration foundation, but its product model still revolves around sessions and separate status widgets. t3code models the work inside a conversation more explicitly and connects that model to compact live status, child navigation, approvals, lineage, and recovery. Ari should improve the continuity from assignment through execution, review, and integration. A larger dashboard by itself would leave most of that problem intact.

There is also a concrete correctness problem in Ari's direct Codex app-server adapter. A scripted transport reproduced child completion ending the root stream and killing its process before the root completed. This deserves the first implementation slice because accurate lifecycle ownership is a prerequisite for accurate UI.

The research included Ari contracts, renderer components, provider adapters, delegation control, worktree integration, and existing tests; t3code's current contracts, orchestration runtime, client projections, components, recovery infrastructure, and selected tests; and visual inspection of running Ari and the orchestration demo on t3code's public website. t3code was not installed or run with live providers. Repository tests were read for evidence of intended behavior, not treated as independently verified passing tests. Two focused diagnostic probes against Ari were actually executed without starting a provider.

**What Ari already has**

It would be inaccurate to describe Ari as missing multi-agent orchestration altogether. The current implementation has:

- Parent/root relationships, delegation roles, and explicit lead guidance.
- Provider and model discovery, policy-limited delegation, permissions, depth and concurrency controls.
- Queued child work and follow-up prompts.
- Child states including queued, working, blocked on the parent, blocked on the user, waiting for children, and result available.
- Automatic parent wake-up with child results, acknowledgement of delivery, and cascade stop.
- Isolated worktrees carrying the parent's spawn-time workspace, including eligible uncommitted changes.
- Snapshot-based review and explicit integration, stale snapshot rejection, and three-way conflict handling.
- Journals, session replay, usage aggregation, and soft tree budgets.
- Scheduled prompts and some provider-native background-task recognition.
- A session tree, transcript delegation rows, a composer child strip, and a Plan/Team surface.
- Substantial source-control review functionality, including comparisons, diffs, checkpoints, and hosted requests.

These are assets to keep. The improvements should connect and refine them. [A1–A8]

**The comparison**

| Area | Evidence in t3code | Evidence in Ari | Practical implication |
| --- | --- | --- | --- |
| Execution identity | App thread, counted run, run attempt, execution nodes, provider threads, requests, checkpoints, and context transfers have separate identities. | Sessions, turns, tool calls, child sessions, and background tasks exist, but normalized provider events often omit execution ownership. | Introduce explicit ownership and correlation before expanding orchestration UI. |
| Live visual hierarchy | Published demo uses a compact subagent summary in the conversation, a live waiting line with Stop, and a Lineage list in the side panel. `ThreadNow` provides a shared family of status lines. | A Team card above the transcript, delegation rows within it, and a child strip by the composer show overlapping information. | Assign one purpose to each surface and remove the permanent Team summary from the reading column. |
| Status consistency | Client projections derive run/subagent activity and capability-sensitive presentation. | Team rows distinguish queued/needs lead; transcript derivation collapses both into waiting. General activity has four phases. | Use one orchestration projection and shared presentation rules. |
| Child decisions | `ChildThreadApprovals` exposes child approval details and response actions in the parent, including stale process feedback. | Children are marked paused and can be opened; the inspected parent view handles its own approvals and questions. | Add an actionable parent attention queue that responds to the actual child request. |
| Native children | Contracts distinguish provider-native children from app-created delegated threads; native child work can be read without pretending it accepts messages. | ACP-derived background tasks exist, but the app-server mapper can lose native child ownership. | Present both kinds coherently while preserving their actual available actions. |
| Forking and provider handoff | Contracts and `ContextHandoffService` implement explicit transfers, fork deltas, provider handoffs, and side-chat context. | UI locks provider/model after a turn; delegated children start from a self-contained prompt and workspace rather than inherited conversation. | Add context packages first, then deliberate handoff/fork workflows. |
| Restart/retry | Durable command receipts and a leased effect outbox are wired into the runtime. Process-bound effects are distinguished from replay-safe effects. | Journals and supervisor recovery exist; control receipts are in memory, with journal-based spawn recovery. | Audit each mutation's crash windows; strengthen only the boundaries that lack durable recovery. |
| Result lifecycle | Delegated results have explicit transfer/delivery state, terminal status, and pending follow-up information. | `ChildTask` includes final text and stop reason; Team/transcript presentation commonly calls result availability Done. | Separate execution ended, result ready, reviewed, tested, and integrated. |
| Workspace isolation | Delegation contract defaults to shared checkout; worktree isolation is an option and excludes uncommitted edits. | Delegation defaults to isolated worktrees based on the parent's spawn-time workspace. | Preserve Ari's default and make the chosen workspace visible. This is an Ari strength. |
| Longer workflows | Scheduled tasks, background commands, workflows, and linked-environment delegation are represented in source. | Scheduled prompts, queues, and child sessions exist; the inspected child assignment contract has no typed dependency graph. | Add a small dependency-aware task layer when workflows justify it. This is a proposal, not a claim that t3code supplies a general DAG scheduler. |
| Interaction polish | Source includes status-specific inline actions, child details, parent navigation, background work controls, and sidebar state transitions. | Existing motion, focus treatments, and activity marks are useful, but operational information is spread over multiple components. | Invest in fewer, more purposeful controls before visual ornament. |

Comparison evidence: [T1–T10], [A1–A10].

**1. Fix root and child lifecycle ownership first. Priority: P0.**

In Ari's `codex-driver.ts`, `connection.onFrame` sends every mapped notification to the same event queue. Any `turn/started` can update `activeTurnId`. In `mapper.ts`, any `turn/completed` produces `done`; the adapter terminates and kills the subprocess at the first `done`. A child `thread/started` can also produce a session reference, and child message/context usage frames lose their thread ownership in the normalized output. [A9]

The external diagnostic transport sent root turn start, child turn start, and child completion, with no root completion. The root iterator ended and the fake process's kill flag became true. A separate mapper probe confirmed unscoped child completion, message, session reference, and context-meter output. This confirms behavior for these input frames. It does not establish how frequently an installed provider emits them or prove that every provider/version follows this route.

The independent **Orchestration engine audit** traced the same path through transport, adapter, engine, and projection and confirmed that no other identity filter prevents it. It also established the transport scope: the desktop prefers ACP and uses `CodexDriver` as fallback; that driver selects direct app-server when supported. The finding therefore applies to the direct app-server fallback and must not be generalized to ACP. See `apps/desktop/src/main/rpc.ts:816`, `packages/providers/src/acp/acp-driver.ts:1351`, and `packages/providers/src/codex/codex-driver.ts:85`. The running session's active transport was not independently established.

The audit additionally verified the downstream effects of lost ownership: `apps/desktop/src/main/engine.ts:1041` persists a mapped session reference and `packages/engine/src/projection.ts:281` replaces the provider session ID; usage/context emissions are attributed to the current Ari session at `engine.ts:987` and `engine.ts:999`. Real child notification delivery remains unverified. The existing single-thread adapter fixture also uses a different thread ID from the one started by its fake server (`appserver.test.ts:443` and `:447`), so tightening correlation requires correcting fixtures as well as adding interleaving coverage.

The fix should preserve root thread and turn identities, keep native child identities, and let only the authoritative root terminal event complete the user-visible turn. Root model-context usage must remain separate from child context usage; tree spending is a different aggregation. Child approval routing must retain the request's owning thread/turn/item. Preserve early root notifications arriving before the `turn/start` response rather than dropping them in an overly strict filter.

Acceptance checks: interleaved root/child text; child completes before root; child failure while root continues; child thread references never replace root resume identity; child turn start does not redirect root interrupt/steer; root context meter ignores child readings; duplicate and late terminal frames do not close a later turn; interrupted root completion remains distinct from successful completion. These are replay/transport tests, not live model tests.

t3code's V2 documents state the root-completion invariant, and the current contracts and adapters implement the identities necessary to honor it. The lesson is lifecycle fidelity, not adoption of its entire framework. [T1, T2]

**2. Replace the always-visible Team card with progressive disclosure. Priority: P1.**

The observed Ari screen gives a separate elevated Team card prime space above the conversation. It carries the team count, role, usage, and model totals, even with one worker and unknown pricing. The same worker also appears in the transcript and composer strip. This makes internal bookkeeping compete with the task itself. `PlanPanel.TeamRow` is a passive list row, so that prominent surface offers less control than its visual weight suggests. [A2, A3]

Use three intentional surfaces:

- **Conversation history:** a small inline delegation group where the assignment happened. Keep its title, compact result preview, and an Open action. It explains history and remains inspectable.
- **Current work:** one compact line near the latest activity, such as `3 agents working · 1 needs approval` with Details and Stop. Attention outranks normal progress. Show this as part of the conversation layout, without a floating panel or large new card.
- **Work details:** an optional docked panel with the task list, current activity, branch/workspace, requests, result, checks, and contextual actions. On narrow windows, use a drawer that closes back to the same reading position.

This follows the responsibilities visible in t3code's demo and `ThreadNow`/relationship components. Preserve Ari's palette, type system, and activity marks. A font change, animated graph, or new glow would not solve the hierarchy problem. [T3–T5]

Suggested arrangement:

```text
Session navigation     Conversation                         Optional Work panel
  Parent task           User request                         Tasks / Decisions / Results
    Worker A            Assignment summary                    Worker A   Testing
    Worker B            Agent explanation                     Worker B   Needs approval
                        Latest activity                       Branch, current action
                        2 working · 1 decision  Details Stop  Inspect / Answer / Stop
                        Composer                              Result / Diff / Checks
```

Use normal rows and separators in the detail panel; avoid another grid of cards. Keep the running task's name readable and its live activity available on demand. Put raw model IDs, tokens, and pricing in secondary detail. If no usage reading exists yet, show no invented zero. When pricing is unavailable, describe it once in the usage detail rather than repeating incomplete-cost metadata in every primary surface.

Acceptance checks: one, four, and fifteen children; long titles; a blocked child amid running siblings; simultaneous completions; narrow split panes; keyboard-only operation; reduced motion; and preservation of transcript scroll position. Worker status should have one obvious place to read and one obvious place to act.

**3. Derive a single orchestration view of state. Priority: P1, alongside the UI slice.**

Ari's `PlanPanel.childState` says Queued and Needs lead, while `delegatedChildState` maps queued and blocked-on-parent to Waiting. Live paused activity can override a task snapshot with Needs you. The Team view sums direct children; other runtime accounting includes the whole tree. These differences may each be locally reasonable, but they produce a fragmented mental model. [A2–A4, A8]

Create one engine-owned projection or shared selector that exposes execution phase, wait reason and owner, result status, integration status, current activity, freshness, and spend scope. Feed the sidebar, transcript group, compact status line, detail panel, and mobile UI from it. UI components should choose how much detail to display without reinterpreting lifecycle independently.

Suggested execution labels: Queued, Starting, Working, Waiting for another task, Needs lead, Needs you, Stopping, Completed, Failed, Interrupted, and Unknown after disconnect. Result handling needs its own fields. A command accepted by the backend is not proof that its effect has completed; in particular Stop requested must not immediately mean Stopped. [T2, T6]

Acceptance checks: all surfaces agree for the same projection; queued work has a reason; a stale provider callback is visibly unavailable; an ended parent awaiting live children remains Waiting; unknown telemetry is not rendered as zero; no cosmetic progress percentage is inferred from elapsed time or token count.

**4. Bring child approvals and questions to the parent. Priority: P1.**

The parent should make a blocked task actionable without forcing a navigation hunt. t3code's `ChildThreadApprovals` shows the originating title, details, provider options, response capability, and errors. Its native-subagent distinctions prevent controls from promising unsupported actions. [T4, T5]

Add a Decisions section to the Work panel, reachable directly from the compact attention line. Each item needs the child title, actual request, relevant command/file, exact provider-offered choices, and current validity. Respond through the child's existing request endpoint; do not synthesize a parent approval. Human approvals remain human decisions. Questions that the lead may answer should say Needs lead, and should not be mislabeled as requests for the user.

Expose Open conversation beside the request for additional context. If the provider process is gone, replace response controls with the supported recovery action and explain the state. Batch controls should be limited to genuinely identical, supported decisions rather than an indiscriminate Approve all.

Acceptance checks: requests from several siblings, answered or cancelled requests disappearing, parent-vs-human ownership, dead callbacks after restart, exact option IDs, response failures, and a child being stopped while its request is visible.

**5. Separate worker completion from usable work. Priority: P1/P2.**

A worker's turn ending is only an execution event. A result may need inspection, correction, tests, and integration. Ari's code already comments that a finished turn is not proof of correctness, but the visible Team row still maps normal result availability to Done. [A1–A3, A7]

Represent an output package with a concise summary, changed files or research artifacts, snapshot identity when applicable, checks with their provenance, unresolved issues, and an explicit next action. Recommended result states: Available, Reviewing, Changes requested, Accepted, and Integrated for code results. Research outputs should be accepted/attached, not falsely marked integrated.

For coding results, show Review diff and the exact snapshot; reuse Ari's existing review workspace and integration protections. Keep tests separate from the worker's claim that tests passed: capture command, working directory, exit status, and snapshot where available. If verification has not been independently performed, label it as reported by the worker.

Offer Send feedback/Retry in the same context. Retain the accepted result and review history even if a follow-up turn is started. Do not overwrite the entire task outcome with the latest transcript message. The real unit to approve is a particular result or snapshot, not an agent's existence.

Acceptance checks: a completed worker with failed tests; a corrected second result; stale snapshot during review; conflict without changing the parent tree; already-integrated snapshot; parent changes after preview; and research results with no Git diff.

**6. Add typed assignments and dependencies above sessions. Priority: P2.**

Ari's `session.spawn` has a title, role, provider/model, workspace, and prompt. It lacks typed dependency IDs, acceptance criteria, owned paths, or output contracts. The lead therefore plans and coordinates through prose. A session tree records delegation ancestry, which is different from a work dependency graph. [A1]

Introduce a small app-owned Task record: goal, role, dependencies, assignment/session reference, expected output, acceptance criteria, optional owned paths, workspace policy, and current result. Keep sessions reusable conversations. A retry should create an attempt/result under a task rather than a new unrelated task. A task can await multiple prerequisites without pretending its parent session is one of them.

Example: API implementation and UI implementation can run concurrently; integration testing depends on accepted versions of both. Documentation can be independent until the interface is stable. Show the dependency reason in a row: `Waiting for API result`, not just Waiting. Reject cycles and explain which dependencies are unresolved. Add a graph view later only if real workflows need it; the list should remain sufficient for routine work.

This is an Ari product proposal. The inspected t3code sources demonstrate execution relationships and workflows; they do not by themselves establish a general dependency-aware build scheduler.

**7. Make context transfer deliberate and inspectable. Priority: P2.**

Ari's CLI protocol rightly asks for self-contained briefs because children do not inherit the parent conversation. That protects scope but leaves context quality to the lead. t3code has explicit context transfers and handoffs for forks and provider changes. Its docs describe a target architecture, so this report also checked the current `ContextHandoffService` methods and current contract entities. [T1, T2, T7]

Provide a Context package action with the task brief, selected messages/files, relevant decisions, accepted sibling outputs, workspace base, and source references. Give it a size limit and preview. Record what each attempt actually received. Default to the minimum useful package; do not automatically inject the entire parent transcript and every tool log.

Then add Fork here and Change provider with handoff where capabilities support them. A context handoff must say whether it uses a native fork or a portable summary and what information was omitted. Ari currently locks provider/model after the first turn; relaxing this safely requires explicit provider bindings and transfers, not simply enabling the picker. [A10]

Acceptance checks: same-provider native fork, cross-provider summary, large/truncated context, references to accepted sibling outputs, changing branches, excluded rolled-back content, and sensitive/provider-specific content being kept within its intended scope.

**8. Strengthen crash recovery at mutation boundaries. Priority: P2; pull forward any confirmed unsafe boundary.**

Ari already has journals, supervisor recovery, journal-backed spawn lookup, and integration event records. It should not be described as lacking durability. However, a journaled state change and a subprocess/Git/filesystem effect are different operations; inspect the gap between them. The control service's general receipt map is in memory. A durable spawn event helps recover spawn retries, but does not automatically provide a durable receipt for every mutation. [A5–A7]

t3code implements persisted command receipts and a leased effect outbox, with attempt counts, failures, and explicit distinctions between replay-safe and process-bound effects. Its older V2 README calls the outbox a follow-up; the current `EffectOutbox`, `EffectWorker`, and `runtimeLayer` show that it is now implementation, not merely an aspirational document. [T6]

Audit create/spawn, prompt delivery, answer, stop, destroy, integration, and parent-result delivery separately. For each, document acceptance, side effect, durable outcome, and retry policy. Introduce persisted operation receipts and a small outbox where needed, reusing existing stores. Do not blindly replay provider turn starts after a crash: first reconcile whether the provider accepted them. Use Unknown/recovery-needed when the evidence is insufficient.

Acceptance checks should inject failures after workspace creation, after session creation but before the spawn record, after provider submission, after files are integrated but before the outcome event, and during parent-result acknowledgement. Repeating a command with the same key must recover a concrete outcome or safely explain why it cannot; it must not silently duplicate work.

**9. Expose capabilities and operational health. Priority: P2.**

t3code's capabilities distinguish native thread identities, terminal-state quality, steering, subagent lifecycle, live-only approvals, checkpoint rollback, and context handoff. Ari adapters expose some optional methods, but the inspected `Driver`/`ProviderAdapter` contract does not describe this richer set uniformly. ACP background tracking deliberately works from limited signals. [A11, T2]

Add a small capability contract relevant to actual UI decisions: can inspect/message/stop a child, can steer, can respond after reconnect, supports native fork, terminal status strength, and background-process continuity. Derive actions from these capabilities. Label provider-native children Read only when that is the truth. An unavailable action should have a concise reason.

Add current action, last observed activity, queue reason, model/account, workspace/branch, and explicit verification provenance to Work detail. Expose stale/no-update state without guessing a stall threshold means failure. Keep root context, per-session usage, tree spending, and provider allowance distinct. Soft budgets already exist; present their scope and remaining amount, plus Unknown pricing where applicable. Add limits per task only after the shared projection and task model exist.

**10. Improve direct user control over a team. Priority: P2.**

Ari has lead mode, child navigation, queues, and stop controls. Make these discoverable through a normal Run with agents action that can accept a brief or proposed task plan. Let the user inspect assignments, choose a provider/model when desired, add a worker, redirect a task, stop one task, or stop the whole tree. Reuse the existing provider catalog and policy rather than inventing a second permission system.

An optional Compare models action can launch isolated attempts against the same brief and base, then show outputs and checks side by side. t3code documents a multi-model new-thread flow, but parallel model comparison is a separate user intention from collaborative implementation. Keep their results and workspace ownership clear. [T8]

For shared-write workflows, surface owned paths and warn about a concrete overlap before starting two writers in the same checkout. Preserve isolated coding worktrees as the default. Dependencies and snapshot versions should determine when combined verification may run.

**11. Treat interaction and scale as part of orchestration quality. Priority: P1 for the new surfaces, P2 for broader scale.**

Use Ari's existing motion and focus system. The largest visual gains here come from hierarchy, alignment, legible titles, honest state, and reachable actions. Use tabular numerals for elapsed time, a short fade for a status change, and reduced-motion support. Avoid pulse animations on every worker and automatically opening panels whenever a task changes state.

Keep completed work folded by default but reachable. Preserve sidebar order and scrolling during status transitions. Let keyboard users move among parent/children and open the detail panel without losing composer text. Announce decisions and failures once; do not have multiple live regions continually reading timers or repeating the same status. t3code's `ThreadNow` makes attention an alert while ordinary elapsed status is not an alert. [T3]

Keep orchestration projections incremental and scoped to the open task family. Prefer authoritative streamed updates over repeated broad scans when the backend already knows the state. Ari already coalesces task fetches and transcript publishing; build on that rather than introducing one timer per row. [A4]

Acceptance checks: 15 active workers under current configured limits; a synthetic larger family for browsing/history; bursty outputs; simultaneous requests/results; background tabs; multiple narrow panes; and reconnect. Measure actual update/paint cost and memory before assigning performance claims.

**A practical order of implementation**

| Slice | Concrete output | Main code touchpoints | Completion condition |
| --- | --- | --- | --- |
| P0: provider ownership | Scoped Codex root/child lifecycle and replay fixtures | `packages/providers/src/codex`, event ownership contracts as needed | Child frames cannot terminate or overwrite root execution. |
| P1: orchestration surface | Shared status derivation, compact current-work line, optional Work panel; remove duplicate Team summary | `features/session/PlanPanel.tsx`, `SessionView.tsx`, `ChildSessionActivity.tsx`, `features/transcript/DelegationCard.tsx`, shell navigation | One coherent view of current work, accessible across sizes, without transcript jumps. |
| P1: decisions | Parent attention list for actual child approvals/questions | Existing request RPCs, approval components, Work panel | A blocked child can be understood and answered from the parent with correct ownership. |
| P1/P2: outputs | Result package with checks and Review diff linkage | Child task contracts, existing review workspace, managed worktree integration | Execution completed, accepted, and integrated have distinct meanings. |
| P2: durable operations | Mutation crash audit, persisted receipts/outbox only at necessary boundaries | Agent control, supervisor, runtime, existing persistence | Critical retries survive process loss without duplicate effects or silent lost results. |
| P2: task/context layer | Typed assignments, dependencies, attempts, context packages, capabilities | Contracts, engine projection/scheduler, provider drivers | Real multi-step workflows explain waiting, inputs, retries, and unsupported actions. |
| P3: expansion | Model comparison, richer automation, linked-machine work if desired | Existing catalog, routines, remote gateway | Each addition builds on accurate task lifecycle and reviewable results. |

These are slices rather than calendar commitments. The first user-visible release should combine the lifecycle fix, cleaner surface, consistent status, and child decisions. It should not wait for a full execution-graph rewrite. Later work can add tasks/attempts incrementally behind the existing sessions and journals.

Success can be measured through a small scenario suite: ask someone to identify what each of four workers is doing, resolve a blocked worker, inspect a result, request a correction, integrate a reviewed snapshot, and recover after a forced restart. Record time, navigation count, incorrect assumptions about completion, and whether any work/result is lost. Set targets from Ari's measured baseline; do not invent benchmark improvements.

**Source index**

t3code links pin the researched revision. Some V2 documents describe a target architecture; implementation claims above also cite current code.

- [T1: V2 architecture and lifecycle invariants](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/docs/orchestration-v2/README.md), [core model](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/docs/orchestration-v2/core-graph-and-data-model.md).
- [T2: Current execution/capability contracts](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/packages/contracts/src/orchestrationV2.ts#L260), [Codex adapter](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).
- [T3: Compact current-work presentation](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/web/src/components/chat/ThreadNow.tsx), [background work](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/web/src/components/chat/ThreadActivityBanners.tsx#L169), [public visual demo](https://t3.codes/).
- [T4: Child approvals in the parent](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/web/src/components/chat/ChildThreadApprovals.tsx).
- [T5: Relationship controls and child details](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/web/src/components/chat/ThreadRelationshipsControl.tsx#L394), [provider-native child bar](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/web/src/components/chat/ProviderSubagentBar.tsx), [native child work](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/web/src/components/chat/NativeChildWorkDialog.tsx).
- [T6: Durable effects](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/EffectOutbox.ts#L125), [worker](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/EffectWorker.ts), [runtime wiring](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/runtimeLayer.ts#L318), [command receipts](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/CommandReceiptStore.ts).
- [T7: Implemented context handoff service](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/ContextHandoffService.ts#L47).
- [T8: User thread/worktree and multi-model flows](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/docs/user/thread-sidebar.md), [activity summaries](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/docs/user/activity-log.md).
- [T9: Current delegation tool contracts](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/packages/contracts/src/orchestratorMcp.ts#L168), [service](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/mcp/OrchestratorMcpService.ts), [outside-agent workflow](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/docs/user/outside-agents.md).
- [T10: Subagent display derivation](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/packages/client-runtime/src/state/threadSubagents.ts), [completion-delivery scenarios](https://github.com/pingdotgg/t3code/blob/0f4a13071090e89c6d7eccdb0eb98b3cde1823ee/apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts).
- [A1: Ari control/task/policy contracts](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/contracts/src/agent-control.ts#L80), [session ancestry and roles](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/contracts/src/session.ts).
- [A2: Plan/Team card and state mapping](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/PlanPanel.tsx#L185).
- [A3: Delegation card and state derivation](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/transcript/DelegationCard.tsx#L48), [state join](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/delegation-view.ts#L20).
- [A4: Session task refresh and surfaces](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/SessionView.tsx#L370), [child rail](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/ChildSessionActivity.tsx), [activity derivation](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/session-activity.ts).
- [A5: Control receipts, permissions, spawn and messages](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/engine/src/agent-control.ts#L114), [existing orchestration tests](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/engine/src/agent-control.test.ts).
- [A6: Runtime wiring and integration](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/main/agent-runtime.ts#L145), [delegation state](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/engine/src/delegation-state.ts).
- [A7: Managed workspaces and snapshot integration](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/engine/src/git/managed-workspaces.ts#L343), [source-control functionality](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/docs/source-control.md).
- [A8: Tree usage and budgets](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/engine/src/tree-budget.ts).
- [A9: Codex notification ingestion](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/providers/src/codex/codex-driver.ts#L214), [unscoped terminal mapping](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/providers/src/codex/mapper.ts#L577).
- [A10: Provider/model change guard](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/SessionView.tsx#L1024), [lead launcher](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/shell/NewSessionLauncher.tsx#L276).
- [A11: Adapter contract](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/providers/src/driver.ts), [limited-signal native background tracking](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/packages/providers/src/acp/background-tasks.ts#L5), [background surface](https://github.com/j35dev/Ari/blob/69d032b7857843902a57f05ed9c0726994d5f562/apps/desktop/src/renderer/src/features/session/BackgroundWork.tsx).

**Reproducibility and boundaries**

The t3code sparse source checkout is at `D:/Projects/Ari-research/t3code`. The Ari diagnostic probes and their Vitest config are at `D:/Projects/Ari-research/probes`. Run from the Ari checkout:

```powershell
pnpm exec vitest run --config D:/Projects/Ari-research/probes/vitest.config.mts
```

Observed result: one test file, two diagnostic tests passed. The assertions intentionally describe the current faulty behavior; a successful future fix should change those diagnostic expectations into desired-behavior regression checks. The independent Orchestration engine audit corroborated the source path and transport qualification; it performed no edits or live provider checks. No provider process was launched, no task code was integrated, and no live t3code performance or reliability benchmark was performed. The only product-repository addition from the parent research is this report.
