# arch-28 — Ari Core harness rebuild

Notes on what changed structurally in the built-in harness, and why. Context:
every M11 box was ticked while the harness could not actually work a repository
(see the honesty correction in PROGRESS.md § M28).

## Thinking is not the reply

Reasoner models (DeepSeek, Qwen, Grok via OpenAI-compat) put chain-of-thought
in `delta.reasoning_content` / `delta.reasoning`, or wrap it in `<think>` /
`<thinking>` inside `delta.content`. Markdown strips those tags and the
planning prose ("The user just said hi…") rendered as the assistant message.
The streamer now yields that span as `thinking-delta`, which the transcript
already collapses behind a Reasoning row. The visible reply is whatever sits
outside the tags.

## Tools have to be on the request, not just in the prompt

The system prompt listed tool names in prose, but the OpenAI-compat
`/chat/completions` body never included a `tools` array. Models that know
function calling (Grok especially) then dumped xAI DSML markup into the
assistant text — `<|DSML|invoke name="read">…` — which the transcript
rendered as a broken table (`< | DSML | …`) and the loop never executed.
The request now advertises every built-in (plus mounted MCP tools) as
OpenAI functions. If a provider still writes DSML into the content, the
streamer holds the markup back, parses the invokes, aliases invented
parameter names (`file` → `path`), and emits `tool-started` the same way
native `tool_calls` do.

## Tool naming is a capability, not a style choice

Tools were `read_file` / `write_file` / `edit_file`. Frontier models are trained
against `read` / `write` / `edit` / `grep` / `glob` / `bash`, and a renamed tool
measurably lowers call accuracy — the model reaches for the name it knows and
then has to be corrected by an error. The rename touches three places that key
off tool names, all now on the short names: `MODE_GUARDED_TOOLS` (permission
gating), `PATH_TOOLS` (allowlist candidate derivation), and the guarded set
inside `tools.ts`. The renderer's `toolLabels.ts` already recognised both.

## Every tool result is size-capped

`truncate.ts` holds the shared caps: 2000 lines or 50KB, whichever is hit first,
plus a 240-char cap per grep match line. Two directions:

- `truncateHead` for file reads — the beginning is what matters, and a partial
  line is never returned.
- `truncateTail` for command output — errors live at the end. This is the one
  place a partial line can come back, when a single line exceeds the whole byte
  budget; the slice is taken on a UTF-8 boundary.

Truncation without a way forward is a dead end, so `read` appends a footer
naming the exact next `offset`, and `bash` says which line range it kept. This
is why `read` takes `offset`/`limit` at all: a 10k-line file is readable in
pages instead of being unreadable.

## The prompt carries the environment

`system-prompt.ts` assembles per turn, in order: identity, tool inventory (one
line per tool), guidelines, environment block, workspace layout, project
instruction files. Everything after identity is gathered fail-soft —
`gitSummary` returns null outside a repo, `workspaceLayout` returns null on an
unreadable directory, `loadContextFiles` skips what is missing. A turn never
fails because a prompt ingredient was unavailable.

It is rebuilt every turn rather than cached, because its facts go stale: the
branch changes, the dirty count changes, the date changes. That is also why the
system prompt is deliberately *not* part of the persisted transcript.

## Memory belongs to the driver

CLI drivers resume a provider-side thread by handing `resumeOf` back to the
CLI. Ari Core talks to a stateless HTTP endpoint, so nothing on the other side
remembers the previous turn — the harness has to. `ConversationStore` keeps the
harness view of the exchange (user text, assistant text, assistant tool calls,
tool results) keyed by Ari session id.

Two implementations: `MemoryConversationStore` (process lifetime, the default)
and `FileConversationStore` (one atomically-written JSON file per session).
Reads fail soft — a missing or corrupt file is an empty conversation, not a
broken turn — and session ids are sanitized before they touch a path, because a
separator in an id would otherwise escape the directory.

The loop reports the transcript through `onTranscript` after each mutation
instead of returning it at the end, so the driver can persist in a `finally`
and an interrupted turn still records what was asked and what ran. History is
trimmed through the same `trimMessages` budget as a request, both on load and
on save, so a long session cannot grow the file without bound.

## Two kinds of ordering

Tool calls in one batch fall into two classes. Read-only builtins (`read`,
`grep`, `glob`, `ls`) cannot interfere with each other and are never
permission-gated, so they run concurrently — the fan-out that opens every
exploration used to cost one sequential round-trip per file. Everything else
stays strictly ordered: the sequence is the model's intent, and two writes to
one file must not race.

The distinction is a `readOnly` flag on the tool rather than a name list, so
extensions can opt in. It is checked against `MODE_GUARDED_TOOLS` regardless, so
a tool cannot claim `readOnly` to skip the approval gate. Results are yielded in
call order either way, which keeps the transcript and the message list identical
to the sequential path.

## Compaction, then trimming

Trimming deletes; compaction summarizes first. Past 75% of the budget the older
span goes through the session's own model into a fixed structure — goal,
constraints, progress, decisions, next steps, critical context — and the newest
35% of the budget stays verbatim, so work in progress keeps full detail while
settled history becomes prose.

Three constraints shape where the cut lands. It happens between rounds, never
mid-round, because a mid-round list can have a tool call whose results have not
arrived. It lands on a user message, so the kept span starts a turn and never
opens with an orphaned tool result. And the keep window is a *ratio* of the
budget, not a fixed character count: a harness configured with a small window
would otherwise never find anything old enough to summarize.

The summary replaces the span in the stored transcript too, so the next turn
starts from it rather than re-summarizing. Failure falls back to trimming — a
degraded context beats a failed turn. The `compact` hook returns the message
list it wants the loop to use, and returning the same array means "nothing to
do", which keeps the no-op path allocation-free.

Known gap: usage from the summarization call is not folded into the turn's
totals, so cost under-reports slightly on a session that compacts.

## Endpoints are provider + model list, not provider + model

An endpoint used to be one base URL and one model id. Now it carries a model
list, with one entry marked as the default used when a session does not name
one. `source` on each entry (`discovered` | `manual`) is what makes a refresh
safe: `setModels` merges the fetched list over the stored one and keeps manual
entries the endpoint did not return, rather than deleting what the user typed.

`discoverModels` normalizes rather than assumes, because OpenAI-compatible is a
family of dialects: the id field is `id`, `name` or `model`; the context window
is `context_length`, `context_window`, `contextWindow`, `max_context_length` or
nested under `top_provider` (OpenRouter); Ollama nests the family under
`details`. It never throws — transport failure, HTTP status and an empty catalog
all come back as a reason string, so the UI can show why and fall back to manual
entry.

Discovery and probing run in the main process for the same reason `endpoints.test`
already did: the sandboxed renderer cannot reach arbitrary origins.

## Settings: form first, fetch imports all

The add/edit form used to sit under the saved-endpoint cards. Fetching a
catalog of dozens or hundreds of models stretched a card so far that the form
left the viewport, and a radio on every row read as "pick which models to add"
even though fetch already wrote the whole list in.

The form is now first, with Save/Test above the model list so a fetch cannot
push the actions off-screen. Fetch still imports every discovered model; the
user deletes the ones they do not want. The default is a dropdown, not a radio
on each row. Each list is `max-h-52` scrolled so one endpoint cannot push the
rest of the page away. The Select listbox itself is also `max-h-72` scrolled —
without that, opening Default on an OpenRouter-scale catalog painted every row
into a page-height popover and the glass pane disappeared behind it.

## Where the API key comes from

A key can be in one of two places, and the wrong assumption breaks the headline
flow. A *saved* endpoint's key lives encrypted in the store, reachable from the
main process by endpoint id. A key being typed into the settings form exists only
in renderer state — the endpoint has not been submitted yet. The original code
sent `apiKey: null` in both cases, so paste-URL-and-key-then-fetch answered 401
against any keyed provider, while keyless and local servers worked fine (which is
why unit tests passed).

Both `endpoints.test` and `endpoints.discoverModels` therefore accept a key *and*
an optional endpoint id, preferring the passed key and falling back to the stored
one. Discovery takes an explicit `persist` flag rather than inferring intent from
a missing id: the form needs to send its id (for the stored key, while editing)
without the probe writing an unsubmitted endpoint into the store.

## Model handles

The picker namespaces endpoint models as `ep:<endpointId>:<modelId>`. Only the
first colon after the endpoint id separates the two parts, because model ids
contain colons (`llama3.1:8b`). A bare `ep:<endpointId>` — what sessions saved
before this change carry — still resolves, to the endpoint's default model.
