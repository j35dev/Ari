# M34 — Ask the user, plan approval, no history reprint

## Why

Three live Grok-in-Ari failures, all ACP-client gaps:

1. **`ask_user_question` vanished.** Grok (and Claude, via ACP elicitation) reverse-RPCs the
   client when the model wants a structured answer. Ari answered `-32601`, so the tool failed
   and the QuestionPanel never mounted.
2. **Plan mode stuck.** Grok's `_x.ai/exit_plan_mode` must be answered with a JSON-RPC *success*
   `{ outcome: "approved" | "cancelled" | "abandoned" }`. A method-not-found error is what the
   CLI reads as "the client disconnected"; plan mode stays active and the approval is supposed
   to reappear on reconnect — which it never could, because Ari still didn't implement the method.
3. **Follow-up turns reprinted history.** Ari spawns a fresh ACP process per turn and resumes
   with `session/load`. The spec says the agent replays the prior conversation as `session/update`
   notifications *before* that call returns. `createAcpAdapter` attached `onSessionUpdate` first,
   so the replay was journaled as the new assistant message, then the real answer streamed into
   the same message. Hermes often skips replay, which is why this showed up on Grok first.

## What changed

- `onSessionUpdate` is attached only after `session/load` / `session/resume` returns. Replay
  chunks are dropped; Ari already has that transcript in the journal. When the agent advertises
  `sessionCapabilities.resume`, Ari prefers `session/resume` (restore context, no replay).
- Initialize now advertises `clientCapabilities.elicitation.form`. Claude's AskUserQuestion is
  disabled by the adapter unless this is present.
- `AcpConnection` routes `elicitation/create`, `_x.ai/ask_user_question`, `x.ai/ask_user_question`,
  `_x.ai/exit_plan_mode`, and `x.ai/exit_plan_mode` to the adapter, which parks them as
  `input-requested`. `input.respond` is forwarded into `adapter.respondInput` and answered as
  a JSON-RPC success (never an error). Dispose cancels parked requests the same way.
- Permission options that are *not* allow/deny kinds (pi select/confirm) render as a question
  rather than an ApprovalCard.
- Ari Core's `ask_user_question` tool parks through the same `input-requested` / `input.respond`
  path so custom endpoints get the same UI.
- QuestionPanel is a one-question-at-a-time interview (progress, full-width option
  rows, Other, Back/Continue). Plan approval opens a markdown rail beside the
  transcript (Approve / Request changes / Abandon). Submit clears the overlay
  immediately; a rejected `input.respond` restores it.

## Effort levels from the harness

The composer Effort chip used to be a local `low | medium | high` preference that
never reached a driver. ACP already advertises a thought/reasoning selector:

- spec category `thought_level`
- id/name aliases `effort`, `thinking`, `reasoning_effort` (Claude, Codex, Grok)
- a thinking-shaped `modes` list (`off` … `xhigh`) for agents like pi that model
  effort as `session/set_mode` rather than a config option

The same throwaway ACP session that probes models now also records that catalog
(plus Grok's initialize `_meta.modelState` reasoningEfforts, and a missing
`type: select` which Grok omits). Grok and Ari Core keep a documented fallback
vocabulary so the chip is visible before the slow ACP probe returns. The pick
is stored on the session and applied at turn start with
`session/set_config_option` (Grok also gets `--effort` on spawn) or, for the
pi-style axis, `session/set_mode`. Ari Core sends `reasoning_effort` on
OpenAI-compat requests and a thinking budget on Anthropic. Permission-mode
axes are never treated as thought.

## Deliberate cuts

- URL-mode elicitation is declined (Ari advertised form only).
- `session/request_permission` with standard allow/deny kinds still uses ApprovalCard.
- Compact PlanApproval inside QuestionPanel is a fallback; the session view prefers
  the plan rail. The rail reuses the transcript MarkdownBlock pipeline.
