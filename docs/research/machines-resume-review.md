# Machines resumed coordination

2026-11-11: C: cleanup restored approximately 18GB free. Commit headroom was
approximately 3GB when coordination resumed. The new resource rules are in the
design doc; they replace the earlier disk-only and physical-memory gates.

The old Tailscale conversation permanently failed with a provider resource
mismatch. Its clean D: branch contains cfa56105 (contract) and 0852e3a4 (WIP
backend/tests/docs). A fresh codex/gpt-6.1-sol high/full worker is validating it.
No other worker is running heavy work. B has uncommitted grant/settings changes
and will be completed by a fresh worker after A finishes. C's uncommitted
shared-client/contracts extraction draft is preserved. D/E/F remain pending.

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
