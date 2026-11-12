# Mobile access grants and Settings review

Workstream B, 2026-11-11. Branch: `machines/mobile-access`. Execution:
`codex/gpt-6.1-sol`, high effort, full permissions. Existing B edits were
preserved in `f6bf045d` before validation. Approved Tailscale backend/evidence
commits `b63c309f` and `9df9d9ba` were cherry-picked without conflicts.

## Behavior

- Every new or restored paired device has local `allProjects: true`. Migration
  preserves the separate terminal decision, excludes revoked devices, and saves
  the migrated records. Project IDs remain a compatibility view of the host
  registry. Before that registry loads, the saved snapshot remains available.
- Local queries, commands, command receipts, streams and terminals recognize
  all-project scope. Host project/session existence and other permission checks
  still apply. New projects require no grant edit.
- Managed HTTP and WebSocket callers explicitly clear `allProjects`. Their
  effective projects come from the verified, signed Connect lease. Signature,
  computer, device key, account, audience and 120-second lifetime checks remain.
  An existing lease cannot acquire a new project through local migration or a
  terminal edit.
- Managed device registration refreshes the current host project list on initial
  device sync and the successful 60-second membership heartbeat. Changed project
  IDs trigger another registration POST. Local-only pairings stay out of that
  registration, and no unsigned wildcard/allProjects field is sent.
- Turning terminal access off rejects future terminal operations immediately
  and kills existing shells through the one-second watchdog. Master disable
  closes the terminal manager and gateways.

## Visible changes

- Mobile access explains that phones and computers control work on this host.
  A status panel summarizes setup, with selectable Tailscale/Connect methods
  and numbered enable, connection and pairing steps.
- Pairing approval and device editing show all current/future projects without
  a project picker. Matching confirmation codes remain mandatory. Terminal
  access is a separate explicit checkbox, initially off, with host-user wording.
- Paired device rows show all-project access, terminal status and last seen;
  editing and revocation use inline controls with retryable failures.
- Tailscale conflicts show observed addresses, targets and listening states.
  Foreign roots offer a free alternate port, explicit replacement review with
  an exact mapping confirmation, and a leave-unchanged action. Non-root and TCP
  mappings have no replacement button.
- An owned offline/stale mapping offers repair and removal even when Serve is
  inactive. Removal stays available with remote access off. Repair calls enable
  without a port override so the backend reuses the saved port, including a
  missing root beside surviving mounts. A new suggested port is a separate
  explicit action.
- Connection diagnostics are collapsed; errors stay visible and actions have
  Ari focus states and 44-pixel minimum height. Ari components, fonts and color
  tokens remain in use.

## Validation and evidence

All installs/tests/checks/builds/captures use the shared atomic heavy-work runner
at `D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs`. WIP is committed
before each long step. Test processes use one worker without file parallelism.

- Gateway pairing, gateway authorization/streams and Connect lease suites:
  136 tests passed before the restart compatibility follow-up.
- Desktop RemoteService, RemoteHost, Connect lifecycle and Settings suites:
  141 tests passed after the follow-up, including newly added project creation
  and managed-registration refresh. The earlier run also passed the terminal,
  combined Tailscale pairing and mapping-recovery UI suites.
- The first desktop run found four failures: a real pre-registry restart
  snapshot bug, and three inherited test timing/argument issues. All were fixed;
  the corrected suites passed.
- Capture script: `scripts/research/mobile-access-capture.mjs`. It renders the
  actual Settings component with bundled Ari styles/fonts and synthetic read-only
  RPC, in a temporary Chrome profile under this D: worktree. It never starts
  Electron/Ari or performs live remote/Tailscale/settings operations.

Final focused contract/pairing, lint, formatting and screenshot results are
recorded below after completion. The coordinator owns wide typechecks, builds
and integrated verification.

## Private service and hardware follow-ups

The private Connect broker must accept changed device registrations, apply its
account/project restrictions and sign the authorized current IDs into a newly
issued lease. This repository neither verifies nor deploys that service. New
managed projects may require waiting for the registration heartbeat and lease
refresh. Existing signed leases remain restricted to their signed IDs.

Real-tailnet/non-443 PWA, phone pairing/reconnect, sleep/wake, ACL denial, live
broker refresh and revocation on real open terminals remain the design's
hardware release checks. Component screenshots do not establish those results.

## Takeover security corrections, 2026-11-12

The four inherited WIP files were reviewed and preserved in `63b602af`.
Corrections through `3cbbaaf8` cover these boundaries:

- S3: local/managed lifecycle publication remains serialized and generation
  fenced. Managed terminal execution has a listener-generation guard at the
  actual terminal call, including after asynchronous workspace resolution;
  an old host cannot create a shell after stop or a subsequent managed start.
- S4: managed shells keep the verified lease expiration, cannot be accessed
  through a private caller, renew only from a live project-authorized lease,
  and close on expiration or connector stop. Managed stop awaits PTY cleanup.
  Local shells retain their separate device/terminal grants. The watchdog
  can take up to one second; real detached descendant cleanup is unverified.
- S5: atomic record writes flush before rename and propagate filesystem
  failures. A failed approval, revocation, grant withdrawal or command-history
  write suspends both existing tokens and new device authorization. Terminal
  watchdogs also honor that suspension. Non-ENOENT reads propagate; malformed
  device records block startup with recovery guidance. Migration saves cannot
  publish state before the pairing service constructor has finished.
- After a failed withdrawal, runtime denial stays latched for this service
  instance. Repair storage and explicitly retry the withdrawal before restart.
  If a user restarts before successfully saving, the last durable approval may
  return: the UI error says this plainly. A successful retry/restart has focused
  coverage; no durable-success claim is made for a failed save.
- S6: dispatch requires a successful durable claim write. Corrupt receipt
  structure/outcomes block gateway startup. Unresolved claims survive expiry
  and capacity pressure; full pinned stores refuse new work. Missing status
  returns `conflict` with an unknown-outcome/host-inspection message, preventing
  the old client's automatic `not_found` resend path. Recorded failures also
  advise host inspection instead of suggesting a new key.
- Legacy browser keys have no reliable gateway-origin binding. The original
  IndexedDB database stays untouched; no key is copied to mutable selected
  origins. Each origin requires fresh pairing and a new non-extractable key.

Receipt retention remains bounded to 1,000 records per gateway (terminal
receipts use a separate memory-only store). Completed/failed records can be
evicted; unresolved claims cannot. This v1 protocol does not establish
arbitrary-old exactly-once execution: a cached client can directly replay an
evicted UUID without checking status. A negotiated epoch/reservation protocol
would be needed for that guarantee. Missing receipts require inspection, and
unknown terminal input must not be automatically replayed. Core owns shared
client reconciliation changes; this branch changes the gateway response.

Final exact checks and screenshot evidence are appended after completion.
