# arch-03 — Engine core

## Event sourcing

Commands dispatch from the renderer → pure decider → journal events →
projection → read model. Journals are append-only JSONL with size-based
rotation and crash-tail repair (torn final line detected on read, truncated
via `repairTail`).

## Session store

Per-session journals under `<userData>/sessions/<sessionId>/journal.jsonl`.
The projection folds events into a `SessionReadModel` (session, messages,
active turn, pending approvals, checkpoints). Boot replays all journals.

## Command dispatcher

Pure function `decideCommand(model, command, ids)` returns accepted/rejected
with the exact events to persist. The engine persists decided events, then
executes side effects (spawning adapters for turns). Idempotent by seq —
retries re-read the journal and continue from the last known sequence.
