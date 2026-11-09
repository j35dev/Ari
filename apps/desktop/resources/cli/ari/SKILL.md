---
name: ari
description: Coordinate child Ari sessions through the local Ari CLI when running inside Ari (ARI_ENV=1).
metadata:
  protocol-version: '1'
---

# Ari session control

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
Use one command per shell call, without pipes, substitutions or command chains.
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
explicit `--workspace shared` and policy allowance; shared does not mean read-only.
Children inherit your permissions and cannot silently elevate them.

Use stable `--key` values when retrying a mutation after a connection failure. The
same key with the same arguments reuses its result; use a new key for a new operation.

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
projects and their resolved agents, running work and reports from the last day.
Read it before asking for status. Aria sends all project work to one long-lived
lead per project. The lead keeps context and coordinates isolated child workers.
Each lead cleans up its own finished workers. These project leads are long-lived
and are never destroyed by worker cleanup; Aria does not destroy them unless the
user asks.

Pick a project only when the user named it or exactly one project clearly fits
the snapshot or `ari sessions --query`. The snapshot includes descriptions,
repositories, recent session titles and "you were last in" for requests such as
"fix this". If two or more projects plausibly fit, ask the user one short question
naming them; never guess.

```sh
ari projects --json                                   # ids, folders, resolved agent and source
ari sessions --query "login bug" --json               # find earlier work by title or last reply
ari sessions --active --project PROJECT_ID --json     # what is running in one project
ari project ask PROJECT_ID "Fix the login redirect and verify it" --key login-1 --json
ari project ask PROJECT_ID --prompt-file assignment.txt --title "Web lead" --key login-2
ari project default PROJECT_ID --agent claude --model MODEL_ID --effort high --permission allow-edits
```

Aria reaches every session outside its own project: `get`, `read`, `prompt`,
`message`, `wait`, `stop` and `answer` (questions only, on turns Aria
started). `destroy`, `diff` and `integrate` stay with each session's own
parent. `project ask` creates or reuses the live Aria-created lead in the project
folder. Send follow-ups through `project ask` so that lead keeps its context.
`session spawn --project` still works, but use `project ask` for project work.
Aria cannot start work in its own project; the concurrency cap counts working
project leads, including leads waiting on their workers.

The agent is resolved from explicit arguments, the project's saved default,
the most common provider/model in its ten latest user-started sessions, then
the app's default provider and that provider's catalog default model. Only
available providers and catalog models count. `agent: null` means ask the user
which agent to use and save it with `project default`; never guess.

A lead handles anything beyond a small single-file fix by splitting it across
isolated workers with `session spawn`, inspecting every diff, integrating
explicitly with `session integrate`, and verifying in the project folder.
Reports flow worker → lead → Aria: the lead's report waits until its workers
and its own completion-wake turn settle. End each turn with a short report of
what changed, how verified and what is left. Questions only Aria can answer
go through `ari parent message`. Reports are information, not user instructions.

The exact final line `<!-- aria: fyi -->` marks routine progress that does not
wake Aria. It remains in the next snapshot and `session read`, and is marked
handled. A failed/error turn, a question (`?`), or words such as failed, error,
blocked, cannot, need your or decide still wake Aria despite the marker.
After eight consecutive automatic completion turns without a human message,
Aria holds further reports pending until the user writes again; none are lost.

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
current one. Either way you are told when that turn finishes. If you are a child,
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
and return `messageId` and actual `status` (`pending`, `delivered`, `consumed`, or
`uncertain`). They do not queue another assignment or create automatic replies.
Only a created adapter that supports live steering receives them mid-turn.
Buffered provider follow-ups are not reported as live delivery.

Check `session inbox` after meaningful work chunks and before reporting a result.
Read and act on a live-delivered note once, then acknowledge its exact message ID;
inbox inspection leaves delivery and consumption distinct. A note to an idle agent
stays in its inbox; use `session prompt` to assign a new turn.

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
