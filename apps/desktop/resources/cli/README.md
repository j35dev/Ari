# Ari session control

The CLI and `ari/SKILL.md` ship with the desktop app. Providers receive a private
launcher on their process PATH, session identity, a local socket/pipe endpoint and
a session-scoped credential. No global PATH or agent configuration is modified.
Run `ari --skill` for commands, examples and the versioned protocol instructions.

## Policy and lifecycle

Permissions settings control delegation, approval, child count, root-wide active
count, depth, recursive delegation and shared-workspace opt-in. The first request
per root asks through the existing approval card by default. A child cannot gain
more permission than its parent. Siblings and unrelated roots are outside its
control scope; a child can send an attributed message to its direct parent.

Children are ordinary persisted sessions. Archive/unarchive applies to a subtree.
Deleting a parent (UI or `ari session destroy`) stops live turns and removes the
whole subtree. `session stop` keeps the child for follow-up; destroy removes it.
Nothing is automatically merged, committed, pushed or removed from Git.

## Result delivery

A child's settled turn is recorded on its parent. Unless the parent already read
that outcome (`session wait`, `read` or `status` acknowledge it), Ari starts a
turn on the parent with one notice covering every finished child. Delivery only
happens to an idle parent whose last turn ended cleanly and whose queue is empty;
otherwise the outcome stays pending and is re-checked at the parent's next clean
settle. Nothing is delivered at application start.

Stopping a session interrupts the live turns of the children it delegated to and
discards outcomes that were waiting to wake it. Both behaviours have a switch in
Permissions settings (`autoDeliverResults`, `cascadeStop`).

## Snapshots and integration

Isolated children start from a temporary-index snapshot of the parent's effective
workspace, including staged, unstaged and untracked files, excluding ignored files.
The real index and HEAD are unchanged. An unborn/non-Git repository cannot create
an isolated child; shared mode must be explicitly allowed and requested.

`session diff` retains an exact child snapshot and returns its commit ID. Integration
requires that ID and only accepts a direct child's recorded snapshot. Git merge-tree
preflights a three-way merge against a fresh parent snapshot. Conflicts return file
names without touching parent files. Successful integration applies working-tree
changes while preserving the parent's index; it does not create a normal commit.
Repeated/incremental integrations use the durable parent lifecycle records.

## Security and limits

Credentials rotate when the application runtime restarts. Mutating requests are
deduplicated by caller, method and explicit `--key` within that runtime; reuse the
same key and parameters for a transport retry. Integration additionally deduplicates
the snapshot across restarts. Responses, message queues, concurrent connections and
transcript reads are bounded. Wait subscriptions release on timeout/disconnect.

This is an application authorization boundary, not an OS sandbox against arbitrary
code executing as the same logged-in user. Tokens must not be printed or included
in prompts. The CLI never returns them in `ari env`.

## Verification

`pnpm verify` includes contracts, policy, socket, race, workspace, binary/conflict,
approval, hierarchy and fake-provider CLI end-to-end tests. Packaging requires the
CLI/skill on every target and executes the packaged CLI on native-architecture builds.

The opt-in `agent-real-provider.test.ts` smoke uses the installed Claude binary named
by `ARI_REAL_PROVIDER_SMOKE`, with the existing account, only in a disposable Git
repository. It verifies CLI discovery, scoped identity, isolated edits and explicit
integration. It is not run during ordinary CI.
