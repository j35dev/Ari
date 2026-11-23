# SDK integration and streaming fix

Qoder now uses the official Agent SDK (`@qoder-ai/qoder-agent-sdk` **1.0.60**) by default. Pi remains on ACP: the pinned `pi-acp` **0.0.33** implementation already forwards separate text/thought deltas, tool progress and `agent_settled`. Its README's claim that no thought stream exists is stale relative to the published code. A native Pi SDK migration would add a substantially larger runtime without a demonstrated streaming benefit for these fixes.

## Qoder integration

- Uses the detected installed CLI and read-only reuse of its login; no credentials are placed in transcript messages.
- Owns a daemon per parked Ari session. Qoder SDK's implicit daemon is process-wide, so explicit ownership keeps account environments and proxies isolated and gives the existing release/update/archive/shutdown paths a concrete resource to close.
- Preserves explicit permission modes, model selection, workspace, resume reference, system instructions and images. Explicit effort goes through the SDK's supported model-policy `reasoningEffort` parameter rather than an invented CLI flag.
- Bridges exact native approval choices, synchronous questions and MCP elicitation. Supports interruption and native task lifecycle/progress; subagent output is routed to the child transcript using its parent tool reference.
- Reuses the existing tested bounded SDK-session pool lifecycle in an independent Qoder pool. Existing live ACP sessions keep their transport. `ARI_QODER_TRANSPORT=acp` is an explicit rollback.
- Falls back to ACP only before the prompt has been submitted. A failed/interrupted SDK turn is never resubmitted through another transport.
- Keeps the SDK external in the desktop build because it loads daemon/session assets relative to its package. It is declared as a desktop runtime dependency.

## Shared fixes for Qoder, Pi and other adapters

1. **Independent text/private lanes.** Alternating private activity no longer turns `sub` + `scription` into separate transcript rows. Public bytes stay public; private content is not concatenated into the reply. Old journal parts also benefit from the renderer change.
2. **Stable stream identity.** New optional stream IDs and replacement semantics survive engine buffering and message folding. SDK partials reconcile with authoritative complete messages; ordinary final prefixes emit only their missing suffix, while genuine corrections replace in place. Parent and child SDK streams have separate contexts.
3. **Real tool progress.** ACP and Pi print-mode output updates become partial results rather than completions. Partial/final results update the same call record, and late previews cannot overwrite completed output. Desktop and mobile pending-state readers understand partial results.
4. **Bounded conversation activity.** Conversation mode folds confirmed intermediate narration between tools into one same-turn activity stretch. Intro/latest/final prose remains outside. Errors, notices, child handoffs and turn boundaries stop grouping. Every intermediate sentence, argument and result is still inspectable.
5. **Quiet live history.** Activity does not open every step automatically while streaming. Manual disclosure state remains owned by the reader, and failure counts remain visible on collapsed activity. Terminal presentation retains its expanded behavior; raw PTY/xterm handling is untouched.
6. **Readable string output.** JSON-encoded text results render as text rather than a quoted string containing escaped newlines.
7. **Complete trailing record.** The generic CLI pump parses a valid last JSON record even when it lacks a final newline.

Pi's legacy print adapter also now consumes text/thought and tool-output deltas through a stateful mapper, with authoritative `message_end` reconciliation. ACP remains its primary route, including the user's existing CLI settings and extensions.

## Reviewable verification

- Qoder SDK passed a real handshake and exact read-only `sdk-ready` reply using detected **Qoder CLI 1.1.95**, with zero tool calls, on both Node and a hidden isolated Electron host. The owned-daemon path was tested as well.
- Adapter tests cover startup-only fallback, no post-submission resubmission, exact approval scopes, questions, Stop, session reuse, explicit effort forwarding, account environment isolation, parent/child stream identity and authoritative snapshots.
- Regression tests cover the supplied fragmentation mechanism, partial-output state, repeated result delivery, final-record framing and a forty-command narration loop.
- The actual production `TranscriptView` fixture confirms **one public row** for interleaved text/private chunks, and **one collapsed activity group plus two public rows** for the forty-command loop. Expanding it exposes all forty calls and all intermediate progress messages.
- Provider suite, contracts suite, transcript/session tests, engine journal/projection tests and mobile activity tests passed. Final counts are recorded in the worktree's `apps/desktop/out/*tests.json` verification reports. Desktop build and workspace type checks were run separately.

Actual-component replay: **http://127.0.0.1:5317/testing/streaming-fixed.html**. Source is `apps/desktop/src/renderer/testing/streaming-fixed.tsx`; all input is synthetic/neutral and no provider executes there. The earlier mockups and research remain available.

The opt-in live SDK smoke is `apps/desktop/src/main/testing/qoder-sdk.smoke.ts`. Build it separately with Vite SSR, then pass the detected CLI path to the generated script. It makes one bounded read-only model request and prints only verification booleans, not model/private content. It is not imported by the normal app.

These changes were developed and built for review in the isolated worktree. The live coordinator was not restarted.

## Qoder native subagent parity

Qoder's built-in `Agent`/`Task` launches now use the same native task cards, child-session rail and read-only child transcript as Claude, with Qoder labels and icons. Prompt, agent type, reported model, current action, results and running/completed/failed/stopped state come from SDK messages. Child file reads, commands, output and public text remain in that child's transcript and use the shared compact activity presentation.

The tracker reconciles launch-call IDs and native task IDs, including explicit bindings arriving after separate provisional announcements. The journal projection merges exact provider-item identities; it never associates agents by description or timing. A new optional `nativeTaskId` survives journaling and replay so an approval received before its task-start message can still identify the correct child. Opening a card before a late binding preserves its transcript. Stop sends the native task ID to SDK `stopTask`; it does not guess one from the launch call.

Background-agent callbacks remain live after the parent's result. Parent settlement and replay clear parent approvals but retain approvals owned by running native children. Child terminal reports remove those approvals. Root and child stream contexts remain independent; streamed child model/current-tool information is consumed when provided.

Qoder documents its native subagents at <https://docs.qoder.com/cli/subagent> and the SDK `agents`, `AgentDefinition`, task notifications and task controls at <https://docs.qoder.com/cli/sdk/references-typescript>. The pinned SDK's corresponding declarations are `dist/protocol/agents.d.ts` and `dist/protocol/messages.d.ts`. A live CLI 1.1.95 SDK smoke invoked one registered no-tools foreground agent and confirmed its exact `child-ready` output, one completed task, captured prompt, exact parent reply and no errors. It reported `task_started` with `task_type: local_agent`, followed by `task_notification`. **That run did not report a child model name.** Background cancellation and parallel agents were verified with controlled fixtures, not claimed as live captures.

The new actual-component replay is **http://127.0.0.1:5317/testing/subagents-fixed.html**. Details, screenshots, checks and launch instructions are in [native/README.md](native/README.md). All prototype inputs and failures are synthetic; production transports never execute there.
