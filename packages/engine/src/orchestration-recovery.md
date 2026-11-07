Mutation recovery uses per-session journal barriers. The in-memory promise map only
coalesces concurrent calls; it is not the receipt store. A matching completed
receipt returns the persisted outcome. Reusing a key with different input fails.
Legacy control refusals before an effect may be retried after policy or provider
availability changes. A task submission refusal stays inspectable and needs an
explicit corrected retry/attempt. Unknown process effects are never automatically
replayed.

| Mutation                 | Durable acceptance and effect                                                                                                   | Recovery                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn                    | Started receipt, child identity and workspace checkpoints precede creation; session and spawn event precede completion.         | Completed receipt reuses the child. A lost outcome keeps an uncertain receipt and preserves the attempted session/workspace for inspection. Recovery never deletes an orphan or submits another worker automatically. |
| Assignment prompt        | Started receipt precedes the origin-preserving held queue entry; the existing concurrency gate submits it.                      | Completed receipt reuses acceptance. A lost receipt is uncertain; the queue/transcript can be inspected without enqueuing another assignment.                                                                         |
| Coordination message     | Recipient inbox acceptance has a sender/key-derived identity. Live steering has its own delivering/outcome states.              | Recipient acceptance recovers a lost sender receipt. Unconfirmed live delivery remains uncertain and retrievable. Messages never become implicit assignments or automatic replies.                                    |
| Inbox acknowledgement    | Recipient records consumed identity and timestamp before the sender receives an outcome.                                        | The exact consumed identities reconcile a lost acknowledgement receipt. Reads and waits leave consumption explicit.                                                                                                   |
| Question/approval answer | Exact pending request and ownership are validated; journal response precedes the provider callback.                             | A lost callback outcome is uncertain and is never answered again automatically. Provider-offered option IDs and human approval ownership remain authoritative.                                                        |
| Stop                     | Scoped interrupt and held-queue cancellation are journaled before completion.                                                   | Lost outcomes are uncertain. Stop requested and process termination remain distinct. An explicit new operation can re-check state.                                                                                    |
| Destroy                  | Subtree interruption/quiescence precedes store deletion; the caller journal retains the receipt.                                | Partial deletion is uncertain and never repeated automatically.                                                                                                                                                       |
| Parent result delivery   | Receipt names exact child turns before the notice starts a parent turn. The notice origin carries its delivery identity.        | An accepted transcript notice recovers missing child acknowledgements. Without acceptance evidence the receipt remains uncertain. Historical unread reports stay inspectable without unattended replay.               |
| Integration              | A current accepted result and exact snapshot are required; existing worktree integration checks the parent and child snapshots. | Durable completed outcomes replay; Git effects with a lost outcome remain uncertain. Integration is never repeated blindly.                                                                                           |

An interrupted provider process is recorded as interrupted after restart; its
unconfirmed submission is not recreated. Recovery requires an explicit new task
attempt/session or a scoped user/lead action after inspecting the receipt, inbox,
transcript and workspace. No reconnect response capability is inferred from a
replayed request. Provider-native work remains read only unless the created
adapter explicitly supports the action.

Dependent code tasks materialize only after current prerequisite snapshots are
integrated into the parent workspace; report-only prerequisites need acceptance.
Their complete brief is size-checked before workspace/session effects. Attempts
retain the exact prerequisite versions and selected context they received.

Managed-worktree cleanup validates the resolved directory against the managed
root and unlinks symbolic links and Windows junctions before Git removes the
worktree. Shared dependency targets remain outside the deletion traversal.
