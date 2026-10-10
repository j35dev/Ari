---
name: ari
description: Coordinate child Ari sessions through the local Ari CLI when running inside Ari (ARI_ENV=1).
metadata:
  protocol-version: '1'
---

# Ari session control

Activate only when `ARI_ENV=1`. Run `ari env --json` and `ari agents --json`
to discover your session, available providers/models, delegation policy and remaining slots.
If `ari` is absent from PATH, invoke the executable in `ARI_CLI`.
Never print `ARI_CONTROL_TOKEN` or include it in prompts, files or messages.

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

## Getting results

**You are told when children finish.** When a child's turn ends and you are not
already waiting on it, Ari sends you one update containing each finished child's
final report and the list of children still working. So after delegating, do your
own part of the work, then end your turn. Do not sleep, poll, or loop on status
to pass the time: the update starts your next turn.

Results you have already read through `wait`, `read` or `status` are not sent again.

```sh
ari session status --json                                    # every child: state + last report
ari session wait --children CHILD_A,CHILD_B --timeout 1800 --json
ari session wait --children CHILD_A,CHILD_B --any --timeout 1800 --json
ari session read CHILD_ID --tail 6 --json
ari session read CHILD_ID --turns 1 --tools --json
```

`session status` reports each child's `workState`:

- `working` — a turn is running or queued.
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
```

A prompt to an idle child starts a new turn; to a busy child it queues behind the
current one. Either way you are told when that turn finishes. If you are a child,
your final message of each turn is delivered to your parent automatically: ask the
parent only for decisions it can resolve, and do not message it to say you are done.

`session spawn` waits while its approval card is open, so give the human time to
answer; do not fire parallel duplicate spawns. `delegation_approval_pending` means
the card is still open — wait, then retry with the same `--key`. Only
`delegation_approval_required` is a real refusal.

## Stopping and cleaning up

```sh
ari session stop CHILD_ID --key stop-1 --json
ari session destroy CHILD_ID --key done-1 --json
```

`session stop` interrupts the child's current turn, and the turns of anything it
delegated, and keeps the session for follow-up. `session destroy` removes that
child (and any of its descendants) from Ari when you are done with it. Do not ask
the human to delete workers you spawned. You cannot destroy yourself. If the
human stops you, your running children are stopped too.

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
Run final tests in the parent workspace after integrating related work. Stop unused
workers when you may still need them; destroy them when the work is finished.

JSON errors have stable `error.code` values. Respect scope, concurrency and depth
limits. Do not work around a denial by extracting another session's credential.
Summarize the work delegated, changes actually integrated, verification results,
and unresolved issues in the final response to the human.

`ari --skill` prints these release-matched instructions. The explicit command
`ari skill install codex` or `ari skill install claude` installs this skill into
that agent's user configuration; Ari never writes instructions into project folders.
