---
name: ari
description: Coordinate child Ari sessions through the local Ari CLI when running inside Ari (ARI_ENV=1).
metadata:
  protocol-version: '1'
---

# Ari session control

## Explicit app navigation (current Aria only)

Only the current nonarchived Aria chat may use these commands, and only when the
user explicitly asks to navigate. Never open a view to report background work.
Resolve exact IDs with the existing session/project listing; ask when Changes
has no explicit, unambiguous registered context. These commands create no chats,
projects or turns and change no provider, model or permissions.

```sh
ari app open session SESSION_ID --key REQUEST_KEY --json
ari app open aria --key REQUEST_KEY --json
ari app open settings --key REQUEST_KEY --json
ari app open changes --project PROJECT_ID --key REQUEST_KEY --json
ari app open changes --session SESSION_ID --key REQUEST_KEY --json
```

`aria` resolves the persisted current existing topic. Changes preserves the
focused chat and its draft, using the user's sidebar/page preference and the
specified project/session workspace. Archived, missing or unavailable targets
are refused; no title matching or fallback creates or substitutes work.

Read `result.status`: `applied` includes `observed.target` and `mode`, meaning the
selected Shell consumer committed that chat or overlay for this request. It does
not certify transcript/provider loading, native painting, or that the user has
not navigated away since. `unavailable`, `stale`, `superseded`, `failed` and
`unconfirmed` are not an opened-view claim. A disconnect or acknowledgement
timeout can leave an unknown late effect. Reuse the same key to inspect its
original receipt; retry never republishes a successful or uncertain request.
An `uncertain_outcome` may include `details.appOpen` with its preserved target and
last validated receipt. Do not choose a fresh key to resend an unknown action.

## Inline visualizations

When a visualization makes an answer easier to understand, place an `ari-viz`
fenced JSON block directly in your reply. Ari renders it in the conversation on
desktop and mobile, with the user's current theme, font, and surface colors.
Keep the surrounding explanation useful, use accurate data, and state units,
sources and assumptions. Do not make up measurements to fill a chart.

Every object has `version: 1`, `type`, and `title`. Optional common fields are
`description` (plain text) and `source` (plain text attribution). Put every
field on that same object. That flat object is the contract. A single top-level
`data` object that holds only the type's fields is accepted for older replies
and flattened before validation. Repeating a field outside and inside `data`
is rejected. Extra keys, a nested `data` object, HTML, scripts and custom
colors are rejected.

| Type                                | Required fields                                                                                                    | Optional fields                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `bar`, `line`, `area`, `radar`      | `labels: string[]`, `series: {name, values: number[]}[]`                                                           | `unit`, `xLabel`, `yLabel`; bar also supports `orientation: "vertical" or "horizontal"` |
| `scatter`                           | `series: {name, points: {x: number, y: number, label?: string}[]}[]`                                               | `xLabel`, `yLabel`                                                                      |
| `pie`, `donut`, `treemap`, `funnel` | `items: {label, value: number}[]`                                                                                  | `unit`                                                                                  |
| `heatmap`                           | `xLabels: string[]`, `yLabels: string[]`, `values: number[][]`                                                     | `unit`                                                                                  |
| `graph`                             | `nodes: {id, label, description?: string, shape?: string, tone?: string}[]`, `edges: {from, to, label?: string}[]` | `direction: "right" or "down"`                                                          |
| `timeline`                          | `events: {label, date?: string, description?: string, tone?: string}[]`                                            | —                                                                                       |
| `gantt`                             | `tasks: {label, start: number, end: number}[]`                                                                     | `unit`                                                                                  |
| `metrics`                           | `items: {label, value: string or number, detail?: string, tone?: string}[]`                                        | —                                                                                       |
| `comparison`                        | `columns: string[]`, `rows: {label, values: string[]}[]`                                                           | —                                                                                       |

All names and labels are strings. `tone` is `accent`, `info`, `success`,
`warning`, or `danger`. Timeline events and metric cards default to `accent`.
An omitted graph-node tone uses the series palette. Never provide CSS colors,
HTML, JavaScript, URLs for assets, or extra keys; visuals are declarative data.
Each series needs one value per label. Radar charts need 3–12 nonnegative
axes. Pie, donut, funnel and treemap values must be nonnegative and have a
positive total. Heatmap rows match `yLabels`, columns match `xLabels`.
Graph IDs are unique and edges reference those IDs; graphs support flows,
architecture, dependencies and concept maps. Graph direction defaults to
`right`; use `down` for vertical flows. Node shapes are `process` (default),
`decision`, `start`, or `end`; optional node tones use the same theme roles.
Use horizontal bars for long category names. Gantt endpoints use a shared
numeric scale (for example days from the project start); end is at least start.
Comparison rows need one string per column. Keep charts inside the validator:
at most 64 categories and 8 series, 3–12 radar axes, 128 points on each scatter
series, 32 slices for pie, donut, funnel and treemap, 32 heatmap rows and
columns, 40 graph nodes, timeline events, schedule tasks or comparison rows,
8 comparison columns, 80 edges, and 12 metric cards. Labels are at most 120
characters and units at most 30. Numbers must be finite and from -1e12 through
1e12. Blocks are limited to 64,000 characters.

For example, a comparison of hypothetical timings (explicitly labeled):

````markdown
The following timings are illustrative, in milliseconds.

```ari-viz
{"version":1,"type":"bar","title":"Illustrative response time","unit":"ms","labels":["Before","After"],"series":[{"name":"Response time","values":[240,120]}]}
```
````

For relationships rather than measurements:

````markdown
```ari-viz
{"version":1,"type":"graph","title":"Request flow","nodes":[{"id":"user","label":"User prompt"},{"id":"agent","label":"Agent"},{"id":"answer","label":"Answer + visual"}],"edges":[{"from":"user","to":"agent"},{"from":"agent","to":"answer","label":"Responds"}]}
```
````

The same flat fields, one compact illustrative object per type:

````markdown
```ari-viz
{"version":1,"type":"line","title":"Illustrative trend","labels":["Jan","Feb"],"series":[{"name":"Value","values":[2,3]}]}
```

```ari-viz
{"version":1,"type":"area","title":"Illustrative capacity","labels":["Mon","Tue"],"series":[{"name":"Hours","values":[4,5]}],"unit":"hours"}
```

```ari-viz
{"version":1,"type":"scatter","title":"Illustrative points","series":[{"name":"Points","points":[{"x":1,"y":2,"label":"Sample"}]}]}
```

```ari-viz
{"version":1,"type":"pie","title":"Illustrative share","items":[{"label":"Core","value":3},{"label":"Other","value":1}],"unit":"parts"}
```

```ari-viz
{"version":1,"type":"donut","title":"Illustrative split","items":[{"label":"Build","value":4},{"label":"Review","value":2}],"unit":"hours"}
```

```ari-viz
{"version":1,"type":"radar","title":"Illustrative tradeoffs","labels":["Speed","Quality","Cost"],"series":[{"name":"Option","values":[3,4,2]}]}
```

```ari-viz
{"version":1,"type":"heatmap","title":"Illustrative load","xLabels":["Mon","Tue"],"yLabels":["AM"],"values":[[1,2]],"unit":"items"}
```

```ari-viz
{"version":1,"type":"treemap","title":"Illustrative area","items":[{"label":"Platform","value":5},{"label":"Docs","value":2}]}
```

```ari-viz
{"version":1,"type":"funnel","title":"Illustrative stages","items":[{"label":"Seen","value":8},{"label":"Kept","value":3}]}
```

```ari-viz
{"version":1,"type":"timeline","title":"Illustrative sequence","events":[{"label":"Start","date":"Week 1"},{"label":"Finish","date":"Week 2","tone":"success"}]}
```

```ari-viz
{"version":1,"type":"gantt","title":"Illustrative schedule","unit":"days","tasks":[{"label":"Design","start":0,"end":2},{"label":"Build","start":2,"end":5}]}
```

```ari-viz
{"version":1,"type":"metrics","title":"Illustrative figures","items":[{"label":"Saved","value":"4 h","tone":"success"}]}
```

```ari-viz
{"version":1,"type":"comparison","title":"Illustrative choice","columns":["Local","Hosted"],"rows":[{"label":"Network","values":["Optional","Required"]}]}
```
````

Close the fence when finished. Use top-level fences, outside lists, quotes, or
other code examples. The user can hover or focus marks for full data tooltips,
click/tap or press Enter to pin an inspection, toggle or Shift-click to isolate
series, filter and copy data tables, and expand a visualization. Graphs and
schedules have two-axis scrolling, drag panning, zoom, actual-size and fit
controls. Users can also change graph direction and bar orientation.
Ordinary code blocks remain ordinary code. Prefer a table for exact lookup,
a chart for numeric patterns, a graph for connections, and a timeline or
schedule for sequence. Scientific/exportable figures can still be generated
as standalone files when the user needs them.

## Typed tasks and reviewable results

`ari orchestration view --json` (also `ari task view`) reports assignments,
attempts, actual requests, review states, and durable operation outcomes.
Commands take a validated JSON object with `--params`; use `--key` to make
retries idempotent and `--session` to select a session in your subtree.

```sh
ari task launch --key implement --params '{"title":"Implement parser","driverKind":"codex","assignment":{"goal":"Implement the parser","role":"implementation","ownedPaths":["src/parser"],"acceptanceCriteria":["Parser tests pass"],"dependsOn":[]}}'
ari task context --key inputs --params '{"messageIds":["msg_id"],"files":["README.md"],"resultIds":[],"maxChars":24000}'
ari task review --key accept --params '{"taskId":"task_id","resultId":"result_id","state":"accepted","snapshotCommit":"exact_snapshot_oid"}'
ari task retry --key correction --params '{"taskId":"task_id","feedback":"Fix the failed case"}'
```

Dependencies name task IDs and dispatch only after their current code results are
integrated or report-only results are accepted. Results remain versioned across retries. `context.get`, `diff`,
`integrate`, `verify`, `update`, `answer`, `stop`, and `compare` use the same JSON API.
Integration requires an accepted result ID and its exact snapshot; inspect
the diff first. A provider/model change on retry requires `newSession:true`.
Selected context is frozen and recorded on the attempt. Approvals remain
human decisions; leads can answer only their direct child's lead-owned question.

A worker reports checks with:

```sh
ari task result --session parent --params '{"taskId":"task_id","attemptId":"attempt_id","summary":"Outcome","workerReportedChecks":[{"command":"pnpm test","cwd":"workspace","exitCode":0,"snapshotCommit":null,"detail":null}]}'
```

Reported checks are claims. `verify` independently runs `git diff --check`
against the immutable result snapshot and stores command, cwd, exit status,
and snapshot under `verifiedChecks`; it does not independently run tests. An
`uncertain_outcome` receipt means the effect may already have happened;
inspect the task before an explicit new attempt instead of changing keys
and resubmitting blindly. Existing `routine` commands remain supported.
Renderer clients can use the equivalent `orchestration.routine.add`,
`orchestration.routine.list`, and `orchestration.routine.remove` RPCs. A
question can be dismissed with an empty `orchestration.answer` value where
the live adapter supports it; approval values must be exact offered IDs.

Activate only when `ARI_ENV=1`. Run `ari env --json` and `ari agents --json`
to discover your session, available providers/models, delegation policy and remaining slots.
Call it as `ari`. Only if `ari` is absent from PATH, invoke the executable in `ARI_CLI`;
on Windows under Git Bash that path cannot take quoted arguments when it contains a space.
Never print `ARI_CONTROL_TOKEN` or include it in prompts, files or messages.

By default, delegation needs no approval and Ari's own commands run without a
shell permission prompt, including integration, session deletion, answers,
routines and project defaults. Settings → Permissions can change either policy.
Safe `ari` invocations may be chained with `&&` or `||`. Trailing `2>&1` and
`| head` or `| tail` (including `-n N`) are supported.
`ari skill install` still asks because it writes your agent configuration.
Provider tool approvals inside sessions still go to the user.

You remain responsible for the user's task. Delegate independently useful work
when it helps — parallelizable slices in different directories, long-pole
subtasks, or work that benefits from another model. Do not invent a fixed team.
Do not fan out two children onto the same files; those are dependent and should
stay serial or stay with you. Children are normal Ari sessions and remain
available for follow-up turns.

## Delegating

Create a child with a concise title, real catalog model ID and a concrete assignment.
The child starts with only that prompt, not your conversation, so make it self-contained:
goal, scope, constraints, what to verify and what to report.

`--title` is the child's name in the sidebar, on its task card, and in its git
branch (`ari/<title>` plus a short id). Use two to five words a person would
recognize, such as `Edit queued message`. Do not put a session id, a model id,
or the word "child" in the title.

When you tell the user what a child did, use that title. Ari wakes you with a
delegation update the user never sees. Do not quote it, and do not paste session
ids into the chat. The user already has each child in the sidebar.

```sh
ari session spawn --title "Settings persistence" --role implementation --agent codex --model MODEL_ID --prompt "Implement persistence. Scope: engine settings. Reuse the existing store, add tests, report decisions and changed files." --key persistence-1 --json
```

`--role` is one of `implementation`, `research`, `review`, `design`, `test` or
`general`. It tells the child what kind of work it is doing; it grants nothing.

Coding children default to isolated worktrees containing your spawn-time workspace,
including tracked and non-ignored untracked changes. Shared workspaces require an
explicit `--workspace shared` and policy allowance.
Children inherit your permissions and cannot silently elevate them.

Assess each assignment and choose a supported per-model reasoning effort from
`ari agents` using `--effort`: low for a routine extraction or typo, medium for
ordinary work, high for implementation, diagnosis and reviews, and xhigh or
stronger for demanding multi-part work when supported. Explicit requested effort
takes priority. `--effort auto` asks Ari to assess task scope. Omitted effort
uses task assessment with saved or same-model inherited effort as a minimum;
complex work cannot silently inherit low. Unsupported explicit levels are refused.
Launch results include the actual `permissionMode`, `effort` and
`effortSelection` (source, supported levels and reason). A provider with no
effort selector is reported explicitly; do not claim that it runs at high effort.
`session prompt` assesses each follow-up to a session you launched or a direct
worker too; use `--effort LEVEL` to override or `--effort auto` to reassess without
the previous effort as a minimum. Its result reports the resolved agent. Existing
messages, workers and permissions are preserved.

Use stable `--key` values when retrying a mutation after a connection failure. The
same key with the same arguments reuses its result; use a new key for a new operation.

An `uncertain_outcome` stays uncertain on retry and is never submitted again by
that key. Inspect `details.operationId` and the preserved identity before an
explicit recovery action; changing the key alone is not recovery. Worker/lead
details may include `childSessionId`, `stage`, `projectId`, `workspace` and
`workspacePath`: use `session get` or `session read` to inspect existing work.
These identities do not grant permissions or authorize another assignment.

## Leading a team

A session created as a lead ("Lead session" in the new-session menu) starts
with a lead note: coordinate rather than code. Split the work into
self-contained prompts with acceptance checks, spawn every child up front and
let the concurrency cap queue the extras, and answer a worker's question with
`session answer` unless the decision belongs to the human. The rest is the
protocol below — inspect each diff, run `ari session integrate` explicitly, and
do not spawn past a budget line: summarize what is left instead. "Lead" is
guidance, not a permission; the session's mode still governs what it and its
children may do.

## Aria

Aria is the user's coordinator across all projects; `ari env --json` reports
`caller.aria: true` in its sessions. Every turn starts with an `[Ari now]` block:
projects and their saved agents, running work and reports from the last day.
Read it before asking for status.

By default, Aria starts a top-level session directly in the project folder with
`ari session spawn --project <id>` and manages that session itself. Before
starting a new session, find earlier related work with `ari sessions --query`.
Reuse a related session when appropriate and send follow-ups to the same session
with `ari session prompt`. Sessions report back to Aria, which reports outcomes
to the user.

Only one session may work in a project folder at a time, including human sessions
running there and Aria's running workers. A new spawn or restart of a different
session is refused: prompt the working session or wait for it to finish.
Research happens inside that session or after it. Only turns the host is actually
running count; stale journal turns, queued messages and pending reports do not.
A turn waiting on human approval or a question for three minutes stops blocking
new work, even if its provider remains connected.

Create or use a project lead only when the user asks for one, such as "set up a
lead" or "have a lead handle this". For large multi-part work, you may propose a
lead, but ask the user first. Never create a lead on your own. Once requested,
`ari project ask` creates or reuses the long-lived lead and keeps its context
for follow-ups. The lead coordinates isolated workers and cleans up its finished
workers. Leads are never destroyed by routine worker cleanup; Aria destroys them
only when the user asks or a provider/model failure requires a reset.

Pick a project only when the user named it or exactly one project clearly fits
the snapshot or `ari sessions --query`. The snapshot includes descriptions,
repositories, recent session titles and "you were last in" for requests such as
"fix this". If two or more projects plausibly fit, ask the user one short question
naming them; never guess.

For every session or lead Aria starts, use the provider and model the user named
in the message, else the project's saved default. If no provider/model was
chosen, ask the user once for that project which provider and model to use,
suggesting Aria's current model as an option. Save the answer with `ari project default` and use
that default for future sessions. Never inherit Aria's model, choose from recent
sessions, or use the app default. Saving a project default requires `--model`;
an older saved default missing a model needs the user's choice. `agent: null`
means the project cannot currently launch; read `agentError` for the reason.
For `provider_unavailable` or `model_unavailable` on an existing choice, preserve
the saved provider, model, effort and permissions. Restore availability and retry
the same refused operation with the same key; do not ask the user to choose again
or automatically switch models. An explicit new user choice takes priority.
Partial options use the saved default only when they match its provider. Tell the user
which model a newly created session or lead runs on; the result includes its
actual agent and source. When an explicit model differs from the saved model,
its effort is the explicit choice or none, rather than the saved model's effort.

When the user asks to build something new and no existing project fits (none
named and nothing in the snapshot or `ari sessions --query` matches), create a
project with a short, clear name, choose its model, then start a direct session.
Tell the user the project's name and where it lives. If it is unclear whether
they mean an existing project or a new one, ask one short question. Do not create
projects for questions or small tasks that need no code.

`project create` is Aria only and runs without a permission prompt. Without
`--path`, it creates a unique folder under the parent most existing projects
share, or `~/Projects`. Use an absolute `--path` only when the user named a
folder; an existing folder is adopted as is. New folders get Git and an initial
empty commit so sessions can create isolated workers. Existing repositories
are left as is. System folders, drive roots, the home folder itself and Ari's
data folder are refused. The result is `{ projectId, name, path, created }`;
retries with the same `--key` return the same result.

Partial project creation instead returns `uncertain_outcome` with
`details.projectCreation` (`name`, exact `path`, `created`, `phase`, and
`projectId` when registered), plus `failureCode` when known. Inspect that folder
and `ari projects --json`; a registered folder can exist despite a lost success
receipt. The phase names the boundary reached, whose action may have begun.
Same-key retry returns the preserved identity without another folder, Git init
or registration attempt. Missing/corrupt progress supplies no guessed identity.
Folder creation and its first progress receipt are not atomic: a process exit
in that gap can leave a folder without a recorded path.

```sh
ari projects --json
ari sessions --query "login bug" --project PROJECT_ID --json
ari project default PROJECT_ID --agent claude --model MODEL_ID --effort high --permission allow-edits
ari session spawn --project PROJECT_ID --title "Fix login" --prompt "Fix the login redirect and verify it" --key login-1 --json
ari session prompt SESSION_ID "Also cover logout" --key login-2 --json
ari session switch SESSION_ID --agent codex --model MODEL_ID --effort high
ari session destroy SESSION_ID --key cleanup-1 --json
# Only after the user asks for a lead:
ari project ask PROJECT_ID "Have the lead handle the redesign" --key lead-1 --json
ari project lead PROJECT_ID --agent codex --model MODEL_ID --effort high
ari project lead PROJECT_ID --reset
```

Aria reaches every session outside its own project: `get`, `read`, `prompt`,
`message`, `wait`, `stop` and `answer` (questions only, on turns Aria started).
`diff` and `integrate` stay with each session's own parent. Aria may switch or
destroy any top-level session or lead it launched, including its descendants and
worktrees. These commands run without shell permission prompts by default.
An active turn finishes on its original provider before the following turn uses
the new provider with a conversation handoff and transcript divider. The composer
provider picker unlocks for sessions Aria launched too. Switching preserves the
session's permissions. Both switch commands require `--model`; never choose a
provider's default model when no model was given. Destruction and lead resets
also refuse a target above Aria's permissions or an archived Aria caller.

Inherited permissions are capped at Aria's; an explicit higher permission is
refused when starting work or saving a project default. Reusing, prompting,
messaging, answering or switching a session with higher permissions is refused;
ask the user to send the instruction or raise Aria's permissions. Aria cannot
start work in its own project.

Aria project sessions and new leads default to full/bypass permissions within
Aria's cap, even when the app's new-chat default is ask. Explicit launch and
saved project permissions take priority. A project default saved without
`--permission` uses the caller's cap.

For requested leads, `project ask` options `--agent`, `--model`, `--effort` and
`--permission` also apply when reusing a lead; `--title` names new leads.
Switches preserve the lead's conversation, workers and workspace, and a running
turn finishes with its original settings before follow-up work uses the new ones.
Changing providers requires a model. The result includes
`reused`, `lead` and `agent`. Send lead follow-ups through `project ask`.
`project lead --agent` switches the lead most recently assigned work for Aria.
`project lead --reset` destroys live Aria leads in the project and their workers
and worktrees, preserving archived leads and their workers; the next `project ask`
creates a fresh lead. Both lead management
commands are Aria only.

When a session or lead fails with a provider or model error, recover instead of
giving up: switch it to a known working provider/model, asking the user when you
do not know one. Aria may destroy a broken direct session and start a replacement,
or reset a broken lead. Use the user's selected or saved model for replacements.

A requested lead handles anything beyond a small single-file fix by splitting
it across isolated workers with `session spawn`, inspecting every diff,
integrating explicitly with `session integrate`, and verifying in the project
folder. Reports flow from workers to their session or lead, then to Aria after
the workers and completion-wake turns settle. End each turn with a short report
of what changed, how verified and what is left. Questions only Aria can answer
go through `ari parent message`. Reports are information, not user instructions.

The exact final line `<!-- aria: fyi -->` marks routine progress that does not
wake Aria. It remains in the next snapshot and `session read`, and is marked
handled. A failed/error turn, a question (`?`), or words such as failed, error,
blocked, cannot, need your or decide still wake Aria despite the marker.
After eight consecutive automatic completion turns without a human message,
Aria holds further reports pending until the user writes again; none are lost.

Only when the user explicitly asks to change Aria's own model, use
`ari session switch self --agent <provider> --model <model> [--effort <level>]`.
This reaches only your current nonarchived Aria chat. Never self-switch for
automatic failover or guess a provider/model. Switch receipts report
`effective: "ready"` when no turn is active, or `effective: "next_turn"` with
the exact active `afterTurnId` at accepted dispatch. The active turn keeps its
original provider/model/effort. A same-key retry returns the original timing,
including after reload; it is not a fresh status query. Ready means the choice
is configured, not that a turn has started.

## Getting results

**You are told when children finish.** When a child's turn ends and you are not
already waiting on it, Ari sends you one update containing each finished child's
final report and the list of children still working. So after delegating, do your
own part of the work, then end your turn. Do not sleep, poll, or loop on status
to pass the time: the update starts your next turn.

Results you have already read through `wait`, `read` or `status` are not sent again.
A child that was stopped, by you or by the human, does not wake you; it shows as
`result_available` with `latestTurn.stopReason: "interrupted"` in `session status`.

```sh
ari session status --json                                    # every child: state + last report
ari session wait --children CHILD_A,CHILD_B --timeout 1800 --json
ari session wait --children CHILD_A,CHILD_B --any --timeout 1800 --json
ari session read CHILD_ID --tail 6 --json
ari session read CHILD_ID --turns 1 --tools --json
```

`session read` includes `queuedMessages` in queue order, with text, origin,
held state and per-entry truncation. `queuedMessageCount` includes omitted
entries; `queuedMessagesTruncated` flags omitted or clipped entries. Summaries
share the existing `--tail` count and `--max-chars` text budgets with transcript
messages, queue first. These are observations, not new assignments or steering.
`read --turns N` without `--tail` uses the existing 200-message cap; explicit
`--tail` wins, and ordinary read still defaults to six. The character budget
and `truncated` signal still apply.

`session status` reports each child's `workState`:

- `working` — a turn is running or queued.
- `blocked_on_parent` — a turn you started is waiting on a question you can answer.
- `blocked_on_user` — it is waiting for the human to answer an approval or question (`blockedOn`).
- `waiting_for_children` — its own turn ended but work it delegated has not.
- `result_available` — finished; `report` holds its final message.
- `not_started` — created without a prompt.

Use `session wait` only when you need a result before you can continue this turn.
Each target returns `{ status: settled|idle|timeout|pending|destroyed, sessionId, ... }`.
`timeout` means that child is still running — it has not been cancelled, and you
will still be told when it finishes. `pending` appears with `--any`: another
child finished first. `control_timeout` means the control socket stalled — retry
the command.

A finished turn is not proof the work is correct. Read the report and inspect the
diff before integrating; send a correction when needed.

## Talking to children and parents

```sh
ari session prompt CHILD_ID "Fix the failing test and rerun it." --key fix-1 --json
ari session message CHILD_ID "Use SettingsStore." --key answer-1 --json
ari parent message "Which persistence API should I target?" --key question-1 --json
ari session answer CHILD_ID --input INPUT_ID "Use the SettingsStore." --key answer-1 --json
```

A prompt to an idle child starts a new turn; to a busy child it queues behind the
current one. The acceptance receipt says `queued: true` and
`execution: "future_turn"`. `observedActiveTurnId` (also returned as the legacy
`turnId`) is an observed active turn, not the queued assignment's future turn
identity. Same-key retries return that original receipt, even after reload.
Either way you are told when that turn finishes. If you are a child,
your final message of each turn is delivered to your parent automatically: ask the
parent only for decisions it can resolve, and do not message it to say you are done.

`session spawn` waits while its approval card is open, so give the human time to
answer; do not fire parallel duplicate spawns. When a child running your work asks a
question, Ari wakes you with its prompt and `--input` id; answer it with
`session answer`, or ask the human first when the decision is theirs. Approvals stay
with the human, and `session answer` refuses an approval id. `delegation_approval_pending` means
the card is still open — wait, then retry with the same `--key`. Only
`delegation_approval_required` is a real refusal.

## Stopping and cleaning up

```sh
ari session stop CHILD_ID --key stop-1 --json
ari session destroy CHILD_ID --key done-1 --json
```

`session stop` interrupts the child's current turn, and the turns of anything it
delegated, and keeps the session for follow-up. `session destroy` removes that
child (and any of its descendants), including its worktree. Do not ask
the human to delete workers you spawned. You cannot destroy yourself. If the
human stops you, your running children are stopped too.

When the whole piece of work is finished, every child's result is integrated or
explicitly abandoned, and the result is verified in your own workspace, destroy
each finished child with `ari session destroy CHILD_ID --key cleanup-CHILD_ID --json`.
Do this as the last step before the final report and say that the workers were
cleaned up.

Check fresh `session status` and `session read` results first. Keep a child whose
result still awaits integration, that is running, whose latest turn was started
by a person, or that the user asked to keep. Never clean up while follow-ups on
that work are still expected in the same turn. Aria's long-lived project leads
are never part of worker cleanup; each lead cleans up its own workers.

## Scheduled prompts

Schedule a prompt to run once or repeatedly. `--in` and `--every` are minutes;
`--at` is a timestamp. No user is present when a routine fires, so make the
prompt self-contained and never ask a question in it.

```sh
ari routine add --prompt "Check CI and report failing tests." --in 30 --every 120 --json
ari routine add --session CHILD_ID --prompt "Rerun the flaky test." --at 2026-11-01T09:00:00Z --key once-1 --json
ari routine list --json
ari routine rm ROUTINE_ID --key rm-1 --json
```

A routine belongs to the session that scheduled it. Repeats are at least five
minutes apart; missed windows are skipped, not replayed in a burst.

## Integrating changes

```sh
ari session diff CHILD_ID --stat --json
ari session diff CHILD_ID --patch --json
ari session integrate CHILD_ID --snapshot SNAPSHOT_COMMIT --key integrate-1 --json
```

Use the exact `currentSnapshotCommit` returned by a fresh diff. Integration of
that current snapshot is the default. Historical snapshots require an explicit
`--allow-stale`. Integration is explicit; completion never auto-merges. Conflicts
return structured file names and leave the parent workspace unchanged. Retrying
an already integrated snapshot is a no-op.
Run final tests in the parent workspace after integrating related work, then
follow the cleanup rule above before your final report.

JSON errors have stable `error.code` values. Respect scope, concurrency and depth
limits. Do not work around a denial by extracting another session's credential.
Summarize the work delegated, changes actually integrated, verification results,
and unresolved issues in the final response to the human.

`ari --skill` prints these release-matched instructions. The explicit command
`ari skill install codex` or `ari skill install claude` installs this skill into
that agent's user configuration; Ari never writes instructions into project folders.

## Coordination inbox

For multiline or long text, use `--prompt-file PATH` on `session spawn`,
`session prompt`, `session message`, or `parent message`. It reads UTF-8 text
without shell newline/quoting loss. Orchestration commands also accept
`--params-file PATH` for a JSON parameter object. Inline and file input are
mutually exclusive; keep the same key when retrying unchanged file contents.

`session prompt` is an assignment that queues a new turn. `session message` and
`parent message` are scoped coordination: they enter a durable recipient inbox
and return `messageId` and actual `status` (`pending`, `delivering`, `delivered`,
`consumed`, or `uncertain`). They do not queue another assignment.
Only a created adapter that supports live steering receives them mid-turn.
Buffered provider follow-ups are not reported as live delivery.

Check `session inbox` after meaningful work chunks and before reporting a result.
Read and act on a live-delivered note once, then acknowledge its exact message ID;
inbox inspection leaves delivery and consumption distinct. A note to an idle worker
stays in its inbox and enters its next turn's context; use `session prompt` to assign
new work. An explicit note back to the requester of delegated work can wake that
idle coordinator once. Pending provider questions and approvals also wake their
coordinator and Aria, including workers below leads. These are coordination notices,
not assignments; respond only where needed and acknowledge after acting.

`session status --recursive` includes workers under project leads. `session read`
returns current `pendingInputs`, `pendingApprovals`, `questionOwnerSessionId` and
`lastSeq` alongside the transcript. Answer only your own agent-owned question;
coordinate with its named owner otherwise. Approvals always require the human's
original approval card. A request notice's `request.resolvedAt` says it is obsolete,
not that anyone consumed it. `delivering` means submission is in progress;
`delivered` means the adapter accepted the prompt, not that the agent acted on it.

`session wait` also returns immediately for incoming coordination or a direct
child's lead-owned question, even when waiting for every target. Read the inbox
and acknowledge the exact identities after acting on them; a wait never consumes
unread messages. Direct siblings may coordinate and wait, but cannot prompt,
answer approvals, integrate, or control each other's sessions.

```sh
ari session inbox --json
ari session ack MESSAGE_ID --key consumed-1 --json
ari session inbox --include-consumed --json
ari session delivery RECIPIENT MESSAGE_ID --json
```

Inbox acceptance and acknowledgements survive restart. An uncertain live delivery
remains retrievable and is never resent automatically. Reusing a message key
recovers the accepted inbox identity after a lost sender receipt.

## Aria spoken replies

In every final reply as Aria, put a separate spoken line first:

```text
<!-- aria:speak {"text":"The changes are ready. Codex needs your review."} -->
```

Use valid single-line JSON. Give a natural spoken answer with the main explanation, outcome, anything needing the user, and any direct question. Usually use three to six sentences, up to about 1200 characters; simple answers can be shorter. When the user asks to hear all details, include the meaningful details in the spoken version, up to 6000 characters. Turn useful bullet points into conversational prose. Round numbers and use names as people say them; omit raw file paths, IDs, links, code and tables. Put the full written reply after the comment. Progress updates never include a spoken version. Automatic speech is only for the current hold-to-talk request; Read aloud reads the written reply’s useful prose and bullet details on demand. Esc or holding the shortcut again stops speech.
