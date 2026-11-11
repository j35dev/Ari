# Machines resumed coordination

2026-11-11: C: cleanup restored approximately 18GB free. Commit headroom was
approximately 3GB when coordination resumed. The new resource rules are in the
design doc; they replace the earlier disk-only and physical-memory gates.

The Tailscale provider resource mismatch proved intermittent: the old session
continued after the fresh worker started and rewrote WIP history. Both workers'
edits were preserved in b63c309f. The coordinator explicitly confirmed the old
writer idle/stopped, then gave sole ownership to the fresh worker. Its validation
code tree matches b63c309f; 9df9d9ba records final evidence. A is now integrated
after review, with 69 focused tests, desktop/contracts typecheck, scoped lint
and formatting passing. The integration preserves A as separable commits.

Fresh B/C/D/E/F workers author in parallel, one per D: worktree, and all heavy
checks take the shared atomic .heavy.lock lease via scripts/coordination/run-heavy.mjs.
Transient resource-gate failures wait/recheck for up to 15 minutes. Core will
commit shared client/types first for desktop/mobile to cherry-pick. Remaining
workstreams and the two-real-engine proof are still incomplete.

## Review follow-ups for B

- RemoteTailscaleSetup currently exposes disable only while serving=true. An
  owned mapping with a dead or stale gateway has owned=true/serving=false, so
  users need a repair/disable action there too.
- When an owned mapping's root is missing alongside surviving sibling mounts,
  default enable intentionally reuses the saved port. The UI currently always
  passes suggestedHttpsPort, which can select another port instead. Preserve
  the default saved-port repair path unless the user explicitly chooses a new
  address. Cover these states with focused UI tests.
- Validate currentPairedRecords/Connect device sync when projects are added:
  local all-project access never broadens an existing signed lease. Confirm the
  sync/lease refresh trigger and report required private broker work accurately.
- Confirm turning terminal access off closes existing shells, not just future
  creation, since the UI says it does.

## Review follow-ups for C

- Expose allowTerminal only from the authenticated paired-device grant and
  default it false in MachineView. Public capabilities alone do not grant it.
- Preserve machines.events {machineId,message:RemoteServerMessage} and a full
  remoteSessionResultSchema matching existing RemoteHost.getSession.
- Negotiate protocol/capabilities before pairing network mutations as well as
  before ordinary commands. The initial extracted pair flow checks info after
  redeem and needs review against this rule.
- Keep attachment IDs, subscriptions, requests and uncertain receipts scoped
  to the owning machine; never route remote actions through local filesystem
  or command.dispatch handlers.

These notes are review observations, not accepted implementation or test claims.
