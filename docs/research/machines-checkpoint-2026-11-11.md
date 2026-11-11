# Machines checkpoint — stopped at the disk gate

No new feature works end to end yet. The design and shared interfaces are
documented, six isolated workers were launched, and baseline checks began.
Implementation stopped because C: fell below the brief's mandatory 3GB floor.
The fallback of completing A/B first cannot proceed under that gate.

## Preserved result

- Integration: `feat/machines`, `D:/Projects/Ari-machines`, based on
  `origin/main` 6f018a75.
- Design: `docs/design/machines.md` (including shared client/registry/RPC,
  identity/negotiation, exact Tailscale recovery fields, all-project grants,
  Connect lease boundaries, UI ownership, security and hardware checks).
- Commit 527d443a: `docs: define Machines architecture and shared contracts`.
- This checkpoint commit records the stopped state and final coordination
  refinements; it contains documentation only.
- No worker branch has been integrated. No push or PR was made.
- The user's checkout remains on `feat/orchestration-workflows`; it was not
  edited, built in, or switched. Live Tailscale/Ari/settings/devices were not
  changed. Other worktrees/projects were left untouched.

## Storage gate and recovery decision

C: started with 6,696,824,832 bytes free. After workers started dependency installs
and focused tests, several independently measured approximately 0.6GB free. The
latest measurement after stopping was 634,978,304 bytes; D: had
56,159,350,784 bytes free. All instructed installs, pnpm store, npm/Electron
caches and temp paths were on D:.

Windows reported C:/pagefile.sys allocated at 11,070MB. At the stop boundary,
free physical memory was under 900MB and free virtual memory under 1GB. These
observations are consistent with memory pressure and pagefile expansion; an
initial pagefile-size measurement was not taken, so the exact cause of the lost
6GB is not proven. No pagefile/system configuration or unrelated files were
changed to reclaim space.

All six worker turns were stopped or had already stopped themselves. Root test
processes were terminated by matching only node processes whose command line
named D:/Projects/Ari-machines or its assigned worker worktrees. A fresh check
found none remaining. The baseline test exits caused by termination are not
regression failures.

Aria received a coordination request to decide how to restore C: above 3GB and
when to resume. Recommended recovery sequence: verify headroom, serialize
installs/tests, resume A/B first, then C/D/E, and keep F separate. Consider one
test worker and one full suite at a time on this 16GB machine. Keep the requested
provider/model. Worker sessions/worktrees are preserved because follow-ups are
expected; they were not destroyed.

## Workstream status and verification

| Workstream | Branch / D: worktree | State and evidence |
| --- | --- | --- |
| A: Tailscale recovery | fix/tailscale-serve-recovery / Ari-machines-wt/tailscale | No implementation edits or commit. Exact recovery API frozen. Existing 443 mapping to http://127.0.0.1:3773 confirmed, with no listener detected; left unchanged. Main baseline tailscale + remote-origins: 2 suites / 23 tests passed. Installed CLI 1.102.3 confirms --https and --set-path flags. |
| B: all-project grants/settings | machines/mobile-access / Ari-machines-wt/grants | No tracked edits or commit. Grant migration and signed Connect intersection approach agreed. Dependencies installed on D:; baseline not run. A's exact UI contract is documented for resumption. |
| C: shared client/core | machines/core / Ari-machines-wt/core | Uncommitted shared-client/contracts extraction draft preserved; not reviewed or integrated. No machine service or two-engine proof yet. Focused main mobile baseline: 41 tests across authorization/session, device keys and Connect passed (worker report). |
| D: desktop Machines UI | machines/desktop-ui / Ari-machines-wt/desktop | No renderer edits or commit. Dedicated host workspace chosen to avoid local RPC/filesystem routing. Focused main baseline: 4 suites / 80 tests passed (worker report). |
| E: mobile overhaul | machines/mobile-ui / Ari-machines-wt/mobile | Audit assignment started; no tracked edits or commit. No screenshots captured yet. |
| F: concurrent root worktrees | fix/parallel-project-worktrees / Ari-machines-wt/concurrency | Research only; no tracked edits or commit. Root managed worktree support plus effective-folder occupancy required. This branch is independent of feat/machines. |

All workers resolved to `codex / gpt-6.1-sol`, full permissions. A/B used explicit
high effort; C/D/E/F used explicit xhigh. Supported effort levels were verified
with `ari agents` before launching. Managed launcher worktrees on C: contained
no installs/builds; all assignments targeted the precreated D: worktrees.

Root monorepo typecheck passed on the unchanged main code. Contracts baseline:
14 suites / 218 tests passed. Gateway baseline: 6 suites / 160 tests passed.
Full desktop baseline and engine baseline were interrupted at the storage gate;
the root mobile suite was not reached. Do not count interrupted or unrun suites
as passing. Lint and production builds were not run.
Logs are in D:/Projects/.ari-cache/machines-main-typecheck.log,
machines-main-desktop-tests.log and machines-main-remote-tests.log.

C's preserved draft currently changes desktop/mobile package metadata, mobile
gateway-client.ts and session.ts compatibility paths, contracts package metadata,
remote.ts, rpc.ts and pnpm-lock.yaml, and adds contracts/machines.ts and
packages/remote-client. These are unfinished worker changes, not accepted code.

## Security and product decisions

No final security review has run because there is no integrated implementation.
The separate review worker remains to be launched. The design preserves host
approval, explicit confirmation codes, short-lived memory-only tokens, sealed
desktop credentials/non-extractable phone keys, revocation, origin checks,
per-device terminals, signed project-bound Connect leases, and a strict remote
allowlist. Identity is content-free and discovery bounded to tailnet/loopback.

Review decisions when implementation is concrete:

- Prefer free HTTPS 8443 when 443 belongs to another tool. An explicit replace
  action names the observed address/root/target and compares it before writing.
- All paired devices reach every current/future project; terminal remains an
  explicit grant. Connect still requires fresh signed leases for signed project
  IDs and never trusts an unsigned wildcard.
- A dedicated remote desktop workspace is accepted for the first safe UI, with
  its differences from the normal desktop session view reported.
- Phone computer switching may navigate to another host's PWA origin to preserve
  strict origins; it must not weaken origin policy or export device keys.

No user-visible UI changes were implemented, so there is no veto list or before/
after screenshot set yet. Still required: Mobile access settings, Machines
settings, remote sidebar and mobile 360/390px light/dark before/after fixtures.

## Remaining verification and release checks

Still required: review/integrate every worker diff, typecheck/lint, gateway/
contracts/engine/desktop/mobile tests with limited concurrency, production builds,
and the full two-real-gateway/two-real-engine loopback proof (pair, approve,
projects/sessions, create, prompt/stream, approval, stop, revoke, host restart
reconnect, incompatible protocol).

Hardware release gates: two computers on one tailnet; an iPhone on the tailnet;
non-443 URL/PWA install/pair/reconnect; sleep/wake and network changes; tailnet
ACL denial; revocation with an open terminal; sealed desktop-key persistence;
live Ari Connect broker/tunnel leases and new-project refresh. No second real
computer is available here.

## Feasibility and nearby work

Headless hosting is feasible through gateway/engine bootstrap extraction, with
separate lifecycle, updater, provider login and credential-storage decisions.
Load balancing can choose a host at session creation; moving live sessions or
drafts must preserve explicit machine ownership. Aria coordination can later use
the registry/allowlist; today's CLI is local-engine bound. Ari Connect can become
a route adapter later with broker/account leases and explicit origin policy.
None of these extensions is implemented.

feat/aria-experiment overlaps future changes in remote-host.ts, settings schema/
store and settings navigation/search. Its off-by-default experiment gate must
remain intact. No actual conflict-resolution claim can be made before worker
implementation. wip/aria-passthrough and PRs #514/#515 were left alone.

Next action after disk recovery: relay A's frozen contract to B and C's safe
allowTerminal/stream/result-schema additions to D; resume A and B before core/UI,
review and commit A separately, then integrate related branches with plain git.
