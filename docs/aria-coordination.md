# Aria coordination and recovery

Aria's project sessions are independent roots. Their workers belong to the project
lead's tree, so a direct-child-only view is insufficient for coordination.

The request supervisor subscribes before reading journals, traces the requester of
the current work through coordinating parents, and retains one durable inbox notice
per source session, turn, provider request, and recipient. It reconciles pending
requests at startup, and resolves obsolete notices from the source journal rather
than trusting a delayed event payload. Completion and coordination wake turns retain
the original work requester; a human-started turn terminates that ownership chain.

Questions go to the requester allowed to answer them. Aria also receives descendant
attention notices, with the owning lead and current context command, without gaining
authority to answer the lead's question. Approval notices identify the original
session and approval card. Only the human can answer approvals.
Agent answers include the observed turn identity, so a later human turn reusing
the same provider input id cannot receive a stale coordinator answer.

An explicit parent-directed coordination message can wake its idle requester once.
Messages to workers or siblings are available through live steering where supported,
or through the next turn's bounded inbox context. They do not queue assignments.
Busy coordinators keep pending notices until they settle. Stopped, archived, queued,
or failed coordinators are not restarted automatically.
Adapter-ready notifications drain known pending messages accepted after the initial
prompt snapshot. Uncertain messages are excluded from that retry path. Sender
mutation receipts preserve identity while returning the current inbox delivery state.

Inbox acceptance, provider delivery, action and request resolution are different:

| Field/state          | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `pending`            | Accepted durably into the inbox                             |
| `delivering`         | Live or new-turn submission is in progress                  |
| `delivered`          | The created adapter accepted the prompt                     |
| `consumed`           | The recipient acknowledged the exact message identity       |
| `uncertain`          | Submission outcome cannot be confirmed; no automatic resend |
| `request.resolvedAt` | Source request is obsolete; no consumption claim            |

Wake receipts retain exact message identities and use the recipient transcript to
recover accepted turns after a lost receipt. A late pending/delivering update cannot
regress confirmed delivery or consumption. Failed provider creation retains an
uncertain inbox receipt, allowing inspection and an explicit follow-up.

Source settlement and its parent/Aria mirror are separate appends. Startup recovers
missing mirrors from the source journal, retaining the source timestamp. Older
mirrors cannot replace newer completions. Historical results remain readable without
replaying unattended provider work. Final project reports still wait for lead workers
and completion turns to settle.

`session status --recursive` includes project descendants and exposes question owner,
pending request identities and journal sequence. `session read` exposes the same
current requests alongside the bounded transcript. Aria's turn snapshot uses journal
state even when a supplied listing trails it, and identifies agent-owned questions,
human approvals and roots waiting for delegated work.

Recovery does not reconstruct a disconnected provider's response channel. Resume or
switch the session before answering when its adapter no longer supports live input.
Uncertain submissions require inspection rather than retries under new identities.
The existing eight automatic-turn limit also applies to attention turns; pending
notices remain available until a human returns. Inbox context includes up to 32
unconsumed notices and points to `session inbox` for the rest.

The desktop regression uses the real engine, runtime and control CLI with a scripted
provider: a worker blocks below a lead, idle Aria receives the request, the lead
answers, a buffered note enters the worker's next turn, and the final lead result
reaches Aria. On unmodified main (`50ee55d2`) it fails because Aria never receives the
worker question. Engine regression suites additionally cover duplicate requests,
stale resolution, receipt loss, uncertain submissions, replay, ownership, approval
refusal, current-topic recovery, caps and out-of-order completion mirrors.
