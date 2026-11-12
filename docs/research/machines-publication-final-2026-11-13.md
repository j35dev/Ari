# Machines publication, 2026-11-13

Desktop core parity is complete and the fresh full verification pass is clean.
The integrated change also includes all-project phone access, the Mobile access
settings page, the mobile overhaul and the parallel-worktree fix from #517 at
`5010f950`. Headless hosting and transactional remote update execution are
cleanly deferred as permitted by the brief; their designs remain complete.

New chats select This PC, an approved host or Auto below the normal composer.
First Send creates on that host; branch/worktree selection locks it and existing
sessions never migrate. Models, effort, permission choices and defaults belong
to the chosen host. Remote sessions use the normal sidebar, transcript, Changes,
files, terminal and split panes. Repository clones group together; forks group
by their differing origin. Pairing is one-way per direction, with independent
approval for reverse access. Auto starts off and admits only eligible hosts
using fresh authenticated demand-only resources. LAN stays off and no hosted
relay is added. The desktop parity changes preserve phone behavior from the
already integrated mobile overhaul; the complete branch does change mobile
relative to main.

## Exact verification boundaries

The full orchestrator started at frozen application/test checkpoint
`643257addffb9bdbbe749fc78660f44a7a856b16`. Application runtime remains
`da40bbef99343f9dce054889cb336e7ba3977e25`. During that pass, the only additional
non-documentation changes moved the already pinned `ws` dependency into the
desktop production manifest and added a packaging probe (`e7135585`, corrected
at `d8c812ee`). No application, host, crypto, gateway or session runtime changed.
Packaging received a separate frozen install, all ten typechecks, full lint,
both builds, unit checks and actual Windows directory packaging. The exact
corrected archive-load probe then passed against that real package.

This records a clean full package pass plus separately checked packaging
follow-ups; it does not claim every command ran on one immutable final commit.
Later publication commits contain only reports, evidence and screenshots.

| Check | Fresh result |
| --- | --- |
| All ten package typechecks | Passed |
| Full repository lint | Passed |
| Contracts | 224 passed |
| Remote gateway | 182 passed |
| Remote client | 24 passed |
| Engine | 803 passed, 42 files |
| Ari Core | 282 passed |
| Providers | 702 passed, 1 skipped |
| Shared | 16 passed |
| UI | 323 passed |
| Mobile | 371 passed, 49 files |
| Desktop | 3,768 passed, 4 skipped; 348 passed files, 3 skipped files |
| Total across all ten package suites | 6,695 passed, 5 skipped, zero failures |
| Desktop and mobile production builds | Both passed |
| Expanded two-host normal-client proof | 1/1 passed on fresh rerun |
| Identity recovery | 10/10 passed on fresh rerun |
| Packaging unit tests | 3/3 passed |
| Actual Windows directory package and exact archived runtime probe | Passed |
| Refreshed normal desktop screenshots | 16 passed |
| Refreshed Mobile access screenshots | 6 passed |
| Refreshed mobile and recovery screenshots | 56 + 24 passed |

The engine full suite uses 60-second test/hook bounds for loaded Windows
timeout/late-cleanup cases, with unchanged runtime. All tests use one worker,
no file parallelism and the shared below-normal resource lease. Private short
TEMP is on D:. C: free-space and commit-headroom gates remain enforced. The
Machines preview was paused with explicit authorization while checks ran.

Exact commands, resource admission, exit codes, summaries and SHA-256 artifact
hashes are in the [19-step full-pass record](evidence/machines-publication-verification/verification.json)
and [packaging follow-up record](evidence/machines-packaging-verification/verification.json).
The [exact archive result](evidence/machines-packaging-verification/exact-package-result.json)
checks WebSocket constructors from `app.asar/node_modules/ws`, CLI skill, mobile
PWA and native PTY files. It runs packaged Electron only in Node mode without
starting Ari's app lifecycle. Original earlier full-run failures and correction
reruns remain in the [historical completion report](machines-parity-final-2026-11-12.md).

## Security and two-host proof

The fresh [independent publication review](machines-publication-security.md)
found no unresolved actionable source finding within the bounded scope through
`d8c812ee`. It preserves prior independently executed identity, stale-route,
removed-route, replay and combined-loopback evidence; it distinguishes that
execution from its own source review. All reported findings are fixed:

- T1: persistent signed-manifest issuedAt high-water and equal-time intersection
  prevent stale complete reports restoring learned routes.
- T2: early per-origin registration, cancellation and generation fences prevent
  delayed setup sending proof to, or publishing, a removed route.
- T3: normal replay accepts later exact-cursor resume/full starts, retains the
  history prefix and reapplies the live-turn barrier after reconnection.
- Identity recovery: flushed no-replace publication and a separate durable
  recovery winner preserve legacy ID/sealed key continuity across processes;
  corruption and missing established keys fail closed. Cleanup cannot hide the
  original publication error or invalidate a published winner.
- O1/O2: current complete inventory gates setup grouping; captured navigation,
  space and pane ownership fence late first-run completion.
- PK1: the packaging check requires exact archived `./node_modules/ws`, so an
  ancestor/global dependency cannot mask a missing shipped WebSocket runtime.

The expanded proof uses two actual Engines/stores, signed HTTP/WebSocket host
listeners, MachinesService/registry/RPC/preload and the normal SessionClient with
HistoryJournal/TranscriptStore. It covers all 2,406 ordered initial events,
history/live-turn retention, fallback, cooled move-back, distinct route bearer,
one B prompt with A untouched, no reverse authorization, authenticated repository
grouping, lower-load Auto selection, Manual-only exclusion and B-only revoke/cache
purge. A signed incompatible protocol stops the route walk before credentials
without affecting A. Compatibility recovery explicitly reopens the same normal
host replay, retaining history and the original prompt count. This models a host
upgrade with disposable fixtures; no incompatible installed binary or real
tailnet was exercised.

## Screenshots

All refreshed captures are isolated read-only component fixtures. The 16 normal
desktop images and six Mobile access images were visually inspected after this
run; open-picker paint assertions, host chrome, sanitized Changes, permissions
and containment remain healthy. Synthetic uncertain/error states are deliberate.
The changed mobile images were also inspected after their 80-capture rerun.

- [Normal desktop, draft picker, Auto, sidebar and permissions](evidence/desktop-machines-parity)
- [Mobile access, approval and address repair](../screenshots/mobile-access)
- [Mobile overhaul](../screenshots/mobile/after)
- [Mobile uncertain-outcome recovery](../screenshots/mobile/recovery)
- [43-row T3 parity matrix](../design/machines.md)

## Deferred work and real hardware

Not implemented: headless `ari host up/serve/pair/status`, Electron-independent
bootstrap, OS service/profile ownership, secure approval sockets and provider
login ownership; transactional remote update prepare/commit/trial/rollback and
durable status recovery. The exact remaining work is in the
[headless/updater design](../design/machines-headless.md). Manual host update
guidance and version/capability degradation are implemented. A phone composer
machine picker, LAN transport and hosted relay are outside this desktop run.

Still needs two computers on one tailnet and an iPhone: real TLS/DNS/TCP and owned
Serve exposure, non-443 pairing/PWA storage/reconnect, separate directional
approvals, sleep/wake and network/ACL changes, OS keyring restart/unavailable
behavior, power-loss durability, actual provider/PTY descendants and private
Connect registration/lease renewal/revoke. Fixture AES-GCM and file/subprocess
proof do not certify OS secure storage or abrupt power loss.

## Publication and merge order

Publish separate `fix/tailscale-serve-recovery` and integrated `feat/machines` PRs
into main. The former passed 69/69 targeted tests, all nine standalone typechecks,
scoped lint and desktop production build at `9df9d9ba`; `4331873b` adds evidence
only. The latter includes exact #517 `5010f950`; its diff shrinks after #517
merges, and that branch has no newer unpublished commits.

Recommended order: Tailscale address fix, #515/#514, #516, #517, then Machines
after resolving/rebasing the experiment conflicts. Current dry merges are clean
with #514, #515 and #517. #516 conflicts with Machines in `agent-runtime.ts`,
`engine.ts`, `remote-host.ts`, `App.tsx`, `App.onboarding.test.tsx` and
`SettingsWorkspace.tsx`. Preserve its experiment guards ahead of folder admission,
inbound remote restrictions, scoped views and first-Send setup. Contracts, host
and clients stay together so the Machines PR remains buildable. No PR is merged.

Preview uses only Ari Dev Machines, its D: profile, renderer 5197 and disabled
gateway hosting on 8797. Restart observations are recorded in
[the preview record](machines-dev-preview.md). Installed Ari, the user's checkout,
the user's UI dev instance and real Tailscale Serve remain untouched.
