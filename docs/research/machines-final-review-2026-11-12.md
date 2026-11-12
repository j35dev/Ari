# Machines review handoff — 2026-11-12

Machines, all-project phone access, the Mobile access redesign, the mobile overhaul,
Tailscale Serve recovery and isolated top-level sessions are integrated locally.
Execution stays on the owning host. Desktop pairing, host approval, project/session
listing, creation, prompting, streaming, approval answers, stop, revocation, restart
reconnect and version rejection are covered by real engines and gateways on loopback.
Final integrated verification results are recorded below.

Real tailnet/iPhone/private Connect service behavior remains unverified. The desktop
uses a dedicated remote workspace: it submits queued prompts but cannot inspect or
edit the host queue, has read-only file previews and does not integrate remote
sessions into local split panes or expose host provider-account settings. See
[Desktop implementation](desktop-machines.md) for the complete supported action list.

## Review snapshot and history

- Integration: `feat/machines` in `D:/Projects/Ari-machines`; final code snapshot
  **14c63b5e**. Base `origin/main` remains `6f018a75`.
- Frozen design and security contracts: [docs/design/machines.md](../design/machines.md).
- A remains separable as `fix/tailscale-serve-recovery`, tip `9df9d9ba`; contract
  `cfa56105`, implementation `b63c309f`, evidence `9df9d9ba`.
- F remains separable from main as `fix/parallel-project-worktrees`, tip `5010f950` (the fixture follow-up to `54954bb8`).
  Aria pushed `54954bb8` and opened draft PR #517; `5010f950` remains local. The integrated cleanup implementation
  matches the independently reviewed full-session-ID ownership correction.
- This coordinator did not push or open a PR. Machines remains local for Aria review.
- [Complete commit ledger](machines-commits-2026-11-12.md) lists every commit, one
  line per commit, through the reviewed implementation/evidence snapshot. Final
  handoff-only commits follow that ledger.

Integration commits: `ba5011e2` F; `3be4d6fc` B; `fed49312` C;
`f96a6819` E; `418843f8` D. `a16e785c` formats the combined lifecycle and runner.
`2e88b11d` captures the guarded readonly identity inside managed startup and imports
runner timers. `9b98cbb4` retains uncertain mobile integration conflicts;
`3f55df73` formats its regression. These last corrections were reviewed separately.

## Workstreams and verification

| Stream             | Delivered behavior                                                                                                                                                        | Focused worker evidence                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Tailscale      | Shows foreign target and listener status; alternate HTTPS port, exact explicit replacement, owned stale repair, saved-port disable; selected origins/pairing URLs persist | 69 desktop/origin/pairing tests; desktop/contracts types and scoped lint                                                                                                                             |
| B — Mobile access  | Paired devices get current/future projects; terminal access stays explicit; clear setup/status/device UI; signed Connect project intersection and registration refresh    | 188 desktop, 163 gateway, 9 key-store, 28 contract tests; types/lint/format and six screenshots                                                                                                      |
| C — Machines core  | Shared client/contracts, identity/capabilities/discovery, sealed origin-bound registry, host-approved desktop pairing and host-owned RPC                                  | 19 Machines tests including real two-engine/two-gateway lifecycle; 27 RemoteService tests; 244 wire/client/contracts/mobile checks; broader 128 desktop passes, one platform skip; scoped types/lint |
| D — Desktop        | Machines settings, remote sidebar and host choice, dedicated remote session/tools/terminal, scoped drafts/attachments/actions, offline/version states                     | Focused suites/types/lint; final composer correction 28 tests; ten screenshot images with preserved capture transcript                                                                               |
| E — Mobile         | Computer switcher, navigation/home/settings/offline/composer improvements, per-origin/device drafts, guarded forget/cancellation, read-only recovery                      | Final 152 focused tests plus 15 affected tests; types/lint/build; 120 before/after/recovery screenshots                                                                                              |
| F — Parallel roots | Admission by physical folder, automatic isolated root on busy Git project, explicit isolation, CLI/human/Aria recovery, worktree labels and exact branch ownership        | 44 desktop and 137 distinct engine tests; types/lint; real Git foreign-branch preservation regressions                                                                                               |

Worker evidence is separate from coordinator verification. The integrated pass used
`scripts/coordination/verify-machines.mjs` and resource-gated `run-heavy.mjs`, one
test worker and no file parallelism. Up to two heavy steps were admitted only with
at least 6 GiB commit headroom; floors were C free 5 GiB and headroom 1.5 GiB.
Processes ran below normal priority with D: caches/temp. The integrated install used
the existing D: pnpm store and frozen lockfile. No live Ari, device/profile/settings
or Tailscale Serve configuration was changed.

| Integrated check                  | Final outcome                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Monorepo typecheck                | Passed recheck; final desktop typecheck also passed after the fixture correction                                      |
| Full lint                         | Passed recheck; changed App fixture also passed scoped lint                                                           |
| Contracts                         | 224 passed                                                                                                            |
| Gateway                           | 182 passed                                                                                                            |
| Shared remote client              | 24 passed                                                                                                             |
| Engine                            | 803 passed                                                                                                            |
| Ari Core                          | 282 passed                                                                                                            |
| Providers                         | 702 passed, 1 skipped with private D: TEMP; baseline ACL explanation below                                            |
| Shared                            | 16 passed                                                                                                             |
| UI                                | 323 passed                                                                                                            |
| Mobile                            | 371 passed, all 49 files                                                                                              |
| Desktop                           | Full run: 3,660 passed, 4 skipped, one obsolete fixture failure; corrected App/session-start-runtime group: 52 passed |
| Explicit two-engine/Git proof     | 23 passed in 39.95s; both real gateways/engines and the applied-before-journal-failure regression                     |
| Desktop production build          | Passed                                                                                                                |
| Mobile production build           | Passed                                                                                                                |
| Refreshed mobile recovery capture | 24 images, zero mutations, no page/sheet overflow                                                                     |

There are **no unresolved failing assertions**. The 6,588 distinct passing cases
combine the full pass with the justified provider-environment and App-fixture
corrections; they are not a claim that the original orchestrator exited green.
Its original typecheck, lint, provider and desktop failures are preserved in
[verification evidence](evidence/machines-integrated/verification.json), alongside
the passing follow-ups.

The provider assertion exposed the validation runner's shared D: TEMP inheritance
of the Windows Users group. Immutable main's prompt-file test reproduced the same
failure. The same baseline passed all three tests in a task-only private D: temp
directory with a protected ACL for the current user, SYSTEM and Administrators.
The complete provider suite then passed there. No provider source or live profile
ACL changed. Earlier baseline-export setup attempts ran no tests; their missing
Vitest link and tsconfig were corrected before the actual baseline.

Desktop's sole failure was a fixture that threw on the newly required
`session.workspace(checkOccupancy=true)` call. `3adf6212` adds the idle reply and
asserts occupancy is checked before reseeding. The full App file and session-start
runtime group passed 52 tests, final desktop types/scoped lint passed, and the
six-line fix was also appended to standalone F as `5010f950`, then merged as
`14c63b5e`. There was no broad desktop retry. Full desktop elapsed 1,206.45s.
The fresh full mobile and desktop runs had no worker-shutdown timeout; React
act/canvas/navigation and FileHandle-deprecation warnings are retained in logs.

The existing running Ari app was not updated; the implemented parallel-session
behavior takes effect when its reviewed build is installed.

Raw coordinator logs/results: `D:/Projects/.ari-cache/machines-integrated`.
The first typecheck found one managed-start closure narrowing error; the first lint
found three missing runner timer globals. Both were corrected in `2e88b11d` and
rechecked. The security-driven integration receipt regression was added before the
full mobile and desktop suites began. Any baseline/fixture/shutdown exceptions are
listed explicitly with the final results; focused success is not a full-suite claim.

## Security review and remaining limits

Final independent report: [machines-security-review.md](machines-security-review.md).
The fresh reviewer used codex / gpt-6.1-sol, high effort, full permissions, and authored
only review evidence. Reviewed runtime source `3f55df73`; S1–S9 are closed. Report commit
`f4bb8198` is integrated. Later changes are test fixtures, evidence and merge
ancestry only. Both new S9 regressions passed in the integrated mobile suite and
the 23-test real-engine/Git proof.

The integrated diff retains these corrections:

1. Public copied machine IDs never authorize route or credential sharing. Every
   origin pairs independently; no keys are copied to discovered or selected origins.
2. Renderer actions, drafts, attachments, receipts and events stay machine/session
   scoped. Unknown command outcomes cannot dispatch through local fallbacks.
3. Sealed credential publication is transactional. The existing private bearer
   default is 12 hours; managed Connect leases are limited to 120 seconds. Refused/unreachable connections
   clear tokens/grants/catalog state; protocol is renegotiated before renewal retry.
4. Sensitive device/history writes propagate failure and latch runtime denial.
   Non-ENOENT load errors and damaged authorization/history block listener startup.
   Corrupt host identity/registry files are preserved; local RPC still starts.
5. Durable command claims precede dispatch; unresolved claims survive TTL/capacity
   pressure; corrupt history is rejected; absent status is uncertain. Desktop and
   mobile saved-receipt controls only query status, including old v1 hosts and
   terminal creation/input. Nonauthoritative lookup failures retain the original key.
6. Legacy unscoped phone credentials remain untouched because their gateway origin
   cannot be proved. Users must pair afresh per origin rather than trust mutable
   `ari.remote.origin`.
7. Terminal access stays explicit. Managed shells retain verified lease expiry,
   renew only with verified access, and close on expiry, denial or shutdown.
8. Fork results use the real `sessionId` wire shape; child-stop receipts belong to
   the child. Remote file/attachment access remains host-workspace constrained.
9. Root branch cleanup uses a full SHA-256 of the exact session ID. Ambiguous old
   short-key branches are retained; exact old full-ID branches are owned only by
   their matching session. Foreign branches and external junction targets survive.
10. A mobile integration `conflict` exception is uncertain because files may already
    have been applied before journaling failed. The receipt survives remount and
    checks remain read-only. Only a confirmed applied/non-applied result clears it.

Independent reproductions verified the copied-ID pairing boundary, failed approval
save denial, zero legacy-key copying, pinned/corrupt receipts and foreign-root cleanup.
The final integration regression additionally proves applied files can precede a
rejected journal write with the actual Git/ManagedWorkspaces/RemoteIntegration code.

Compatibility limits remain: bounded v1 history cannot guarantee exactly-once
execution for arbitrary direct replay of an evicted key by old cached clients.
Missing status never justifies automatic replay. Failed withdrawal must be saved
successfully before restart; otherwise the last durable grant may return, which
the UI explains. Independent origins have no credential failover. Tailscale CLI
has no atomic compare-and-swap; an unrelated process changing Serve between the
last inspection and CLI write remains an external race. Crash between CLI success
and ownership persistence leaves an unclaimed mapping and fails closed.

## Screenshots and user-visible choices

All captures use real components with synthetic local data and temporary D: browser
profiles, not the user's live devices or app. They were visually inspected.

- [Mobile access ready](../screenshots/mobile-access/settings-ready-porcelain.png),
  [repair](../screenshots/mobile-access/settings-repair-obsidian.png),
  [approval](../screenshots/mobile-access/settings-approval-porcelain.png): six
  light/dark images with [capture metadata](../screenshots/mobile-access/capture.json).
- [Machines settings](evidence/desktop-machines/machines-settings-light.png),
  [remote sidebar](evidence/desktop-machines/machines-sidebar-dark.png),
  [remote workspace](evidence/desktop-machines/machines-workspace-light.png),
  [uncertain receipt](evidence/desktop-machines/machines-receipt-dark.png): ten
  light/dark images, including settings lower sections; [metadata and preserved
  verification](evidence/desktop-machines/capture.json). Viewport 1440 x 1020.
- Mobile: 40 [before](../screenshots/mobile/before/evidence.json), 56
  [after](../screenshots/mobile/after/evidence.json), 24
  [recovery](../screenshots/mobile/recovery/evidence.json) PNGs at 360/390 px,
  light/dark; normal height 844 px plus short-height views. Geometry checks report
  no page/sheet overflow; recovery records zero mutation calls.
- Complete mobile visible-change/veto list: [mobile-overhaul.md](mobile-overhaul.md),
  items 1–16. It covers computer/home/navigation/access/appearance changes,
  offline feedback, wrapping/approval docks, drafts/forget, read-only receipt labels,
  no-project guidance, uploads and constrained fork selectors. The final security
  correction adds explicit unknown-integration guidance.

Product choices for the user to confirm during review: approve the dedicated remote
workspace differences; approve the mobile visible-change list; accept fresh per-origin
pairing for legacy phone credentials and the absence of credential route failover;
retain signed project restrictions for managed Connect rather than a wildcard;
accept preservation of ambiguous legacy root branches. No live Serve replacement
was performed: the setup UI must obtain exact confirmation for a foreign mapping.

## Nearby PRs and future work

Read-only merge analysis against the integrated branch found #514 (dictation
formatting) and #515 (ACP watchdog) clean. #516 (`feat/aria-experiment`) conflicts in:
`apps/desktop/src/main/agent-runtime.ts`, `engine.ts`, `remote-host.ts`,
`apps/desktop/src/renderer/src/App.tsx`, and
`features/settings/SettingsWorkspace.tsx`. Preserve #516's off-by-default experiment
guards when resolving. None of these PRs or `wip/aria-passthrough` was integrated.
#517 already contains standalone F; Machines includes its implementation as well.

Headless hosting is feasible after separating engine/gateway bootstrap from Electron;
secure key storage, lifecycle/updating and provider login need their own design.
Load balancing can choose a host before creation; migration of active sessions or
drafts must preserve explicit host/workspace ownership. Aria can later use Machines
registry/RPC, but the current CLI still targets one local engine. Ari Connect routes
can fit the route model later with broker/account device leases and origin checks;
this work preserves the existing phone Connect path and does not implement a relay.

Release checks still requiring hardware/private services:

- Two computers on one tailnet: discovery, independent approvals, host execution,
  versions, revocation and reconnect.
- iPhone: tailnet access, non-443 HTTPS URL, Safari/installed PWA storage, pairing,
  installation/update/reconnect, keyboard/safe areas and sleep/network/ACL changes.
- Real terminals/descendants: device and terminal withdrawal, signed lease expiry,
  host shutdown and sleep/wake behavior.
- Electron safeStorage credentials across real desktop restarts/platforms.
- Private Connect broker/tunnel refresh and registration of newly added projects,
  while enforcing signed project IDs and account restrictions.
- Disposable real Tailscale mixed mounts, alternate-port update/disable and external
  configuration races. The user's foreign 443 mapping remains untouched.

Aria reviews the local diff first. The local `5010f950` fixture-only follow-up
should update draft #517 before relying on its wide CI; it has not been pushed by
this coordinator. After approval, use disposable profiles/hardware
for these release gates and resolve #516 integration order before shipping.

## Worker cleanup and side requests

Feature workers were destroyed after integration; their Git branches and committed
handoffs remain. The final security worker is destroyed after its report was integrated; its D: proof worktree remains. Aria voice
options (claude/opus/high/full) and Permission selector research
(codex/gpt-6.1-sol/high/full) were spawned explicitly for Aria and are preserved
without review/integration/destruction. Completed side reports are forwarded to Aria.

Automatic approval review rejected recursive cleanup of the residual D: feature
worktree folders and the security reproduction source with `blocked by policy`.
No alternate deletion or force was attempted. The feature worktree registrations
were removed, but residual `concurrency`, `grants`, `core`, `mobile` and `desktop`
directories remain under `D:/Projects/Ari-machines-wt`. The security worktree retains
untracked `.review-temp/reproduce-takeover.mjs`; its data is preserved for review.

Worker runtimes: all Machines feature/review workers used codex / gpt-6.1-sol
with full permissions. A/B/F/security and final desktop replacement used high;
core/desktop/mobile takeover workers used xhigh as recorded in their handoffs.
The two explicitly requested side research workers used their requested high effort.
Both final side reports were forwarded intact and consumed by Aria.
