# Machines onboarding correction: independent final source review

Date: 2026-11-12. Review-only worktree
`D:/Projects/Ari-machines-wt/onboarding-review`, branch
`machines/onboarding-review`. Initial exact comparison:
`e97d3a7ab0639dbf5a2b0bea083a24aeec50bad4` through
`b461c4ff845bc4c428ee32db65acfcbd64f22763`. Follow-up source was inspected through
shared immutable Git objects without changing this worktree's runtime checkout.
**Final reviewed runtime target: `da40bbef99343f9dce054889cb336e7ba3977e25`.**

**Disposition: both identified P2 findings are independently closed in source
at the final target; no unresolved actionable finding remains in this narrow
review.**
Setup no longer creates a durable session before machine selection, and the
correction does not widen host authority or introduce local/remote fallback.
The initial target could capture an incomplete repository projection and replace
work after a wheel-driven space change. Those findings and the intermediate
readiness gap were reported immediately and corrected in the two follow-ups
below. Runtime remediation and App fixtures belong to the parent and test worker;
closure here is source inspection, not a claim of newly executed DOM/hardware
proof or completion of the parent's integrated checks.

## Exact scope and immutable blobs

Baseline ancestry, clean initial branch/HEAD, full name/status/stat and all
runtime/test patches were inspected. The initial range changes 28 paths:
four runtime files, five test files, and 19 research/evidence artifacts. The only
initial runtime correction is `b461c4ff` (`fix(machines): open the first-run project as a
draft before Send`). All other deltas are tests or research/evidence, including
the retained evidence helper, not application runtime.
The final baseline-to-target range changes 29 paths: five runtime files, the
same five test files, and the same 19 research/evidence artifacts. Follow-up
`4cb1746a2ca2c6e27bf8f1789cb04e8284b9e0c7` changes App and the host test;
`da40bbef` adds exactly one readiness reset in `use-machines.tsx`.

Prefix `R = apps/desktop/src/renderer/src/`.

| Initial runtime source | Baseline blob | Initial target blob |
| --- | --- | --- |
| R/App.tsx | `85cd9e11e4e0dcc9a6f29fc49ea36a6e211e5fb7` | `7116bb730927c4b6de2cd1cb93cf902adf041b88` |
| R/features/onboarding/OnboardingGate.tsx | `9090e78185570e08836e58a74a3f459ba8c1ae6d` | `1bb016df3ed339b6278b1581bc026caa66d670d5` |
| R/features/onboarding/OnboardingReady.tsx | `df0cd79719a0287937bdd6f0fde8896ec8598576` | `3c78ef7411416340e494db7ede896ba23511c46d` |
| R/features/onboarding/onboarding-completion.ts | `5fc1ec9a92c4922f2f369322b4a6a0ecab475302` | `d4bb5ef8586703cba59b943e3c6dadd12b3a32f8` |

Surrounding source was independently read. The following blobs are unchanged
from baseline to the initial target and define the relevant normal lifecycle.
Only `use-machines.tsx` in this table changes in the final follow-up, as recorded
below; all other table entries remain byte-identical at the final target.

| Source | Same blob at both commits |
| --- | --- |
| R/features/machines/use-machines.tsx | `67347b34b8da1cd6f87284e3db15fe1856d2cb26` |
| R/features/machines/use-machine-projects.ts | `274d23e94f24e60c874c26eeff38cfd122e948db` |
| R/features/machines/repository-groups.ts | `3d68e52b5998b57c82794d76f9a0d1c744332135` |
| R/features/machines/ProjectDraft.tsx | `e46699a7394ea4f4fc58a61dcd345edd7082b5bc` |
| R/features/machines/ProjectDraftPane.tsx | `aad8fb7bbfb5c84041cb6966cfd631edd4993eea` |
| R/features/machines/project-draft-registry.ts | `ff6890afe32499de6ed32a3af7434f6245bc2af2` |
| R/features/machines/project-draft-adapter.ts | `dd9b5b5ca2b14dcafb0b6350242120e232fcfbe5` |
| R/features/session/session-draft-client.ts | `28ada47aa3864a3f6ced78dae4b84b623bb51bf0` |
| R/shell/use-session-start.ts | `ca3ed560f3726c6a1bbb0440334dd300075797c3` |
| R/use-app-navigation.ts | `f870db75b5d3c386b6f6fd16a589501f6d97cc19` |
| R/features/spaces/use-space-swipe.ts | `fa74d6e17dc978748a3c567c34dd610d4cc7aa8c` |

## Findings at the initial target

### O1 / P2: the first draft permanently captures a partial repository group

`App.tsx:898-902` starts project-list and machine-inventory refreshes without
ordering them. The new handoff at `App.tsx:1135-1139` requires only a group
containing the exact local project ID. `use-machine-projects.ts:11-18` creates
such a group from ordinary projects even when the local snapshot has no entry
for that project yet. With no repository identity, `repository-groups.ts:34`
uses the fallback `checkout:[hostId,projectId]` key.

A concrete source-supported sequence is:

1. Setup imports local project P and returns its ID, with no session created.
2. The shell's project-list refresh resolves before the refreshed local catalog
   or the connected machine's project inventory. Its navigation now contains a
   local-only fallback group for P, so the effect consumes the handoff.
3. `openProjectDraft` stores this group in the draft entry (`App.tsx:1119-1123`).
   The later snapshots establish that P and a permitted remote checkout belong
   to the same repository, updating sidebar/navigation grouping.
4. `ProjectDraftPane` still uses `entry.group`, including for remote `hasProject`
   (`ProjectDraftPane.tsx:33-34,84`). No path refreshes that stored projection.
   The permitted remote machine remains ineligible for this onboarding draft
   even though its matching checkout is now known to normal navigation.

This is an availability/selection defect, not an unauthorized host operation
or wrong-host catalog read. It is timing-dependent and does not require a
malicious peer. Waiting for any local checkout is insufficient to establish
the intended complete repository group.

Recommended correction: gate the handoff on the required catalog readiness or
refresh the exact draft's group projection as authenticated inventories arrive,
preserving its draft ID, selected checkout/host, workspace lock and receipt.
Validate the project-list-first order with delayed local and remote inventory,
then show that the permitted matching remote checkout becomes selectable.

### O2 / P2: a wheel-driven space change does not invalidate the delayed handoff

The pending handoff captures `navigationGeneration` only
(`App.tsx:898-899,1130-1139`). Ordinary pointer and keyboard actions are fenced:
`use-app-navigation.ts:119-125` captures `pointerdown`, `keydown` and `click`,
calling `App.tsx:1279-1282` to advance that generation. Session selection also
advances it directly. My initial broader alert about ordinary clicked/keyboard
draft, pane and space navigation was therefore retracted after inspecting this
global listener. It is not an unresolved finding.

The remaining case is a horizontal trackpad swipe. `use-space-swipe.ts` handles
native `wheel` events and invokes its callback without synthesizing any of
those captured input events. `App.tsx:495-498` calls `spaceActions.cycle`
directly; that action does not advance the shell's navigation generation.

With at least two persisted spaces, hold the first local project-list refresh
after setup succeeds. Swipe to another space whose focused pane contains an
established draft. Resolve the list: the generation check still passes, and
`openProjectDraft` reads the *current* space/pane, appends the onboarding draft,
and clears that pane (`App.tsx:1115-1125`). The newer space selection loses its
visible draft to the late first-run handoff. The same current-pane clear can
affect an existing session when setup explicitly requests a new chat. The old
draft metadata remains stored, so this does not establish durable deletion.

Recommended correction: validate the originating space/layout/pane in addition
to the generation, or invalidate pending onboarding on every successful space
switch including swipes. Validate with a wheel-only space change, delayed
project metadata and a pre-existing draft; the selected space and draft should
remain untouched and no replacement draft should be appended there.

Both findings are established by source control/data flow, not reviewer-run
React or real-trackpad reproductions. Focused fixtures are parent/test-worker
work. No heavy execution was started for this narrow review.

## Independently inspected correction and final disposition

| Follow-up source | Initial target blob | Final target blob |
| --- | --- | --- |
| R/App.tsx | `7116bb730927c4b6de2cd1cb93cf902adf041b88` | `8b02e9a73a6fa1ee52e189c9013af0a6b0aff0ab` |
| R/features/machines/use-machines.tsx | `67347b34b8da1cd6f87284e3db15fe1856d2cb26` | `53caaab10d9c71c6d4682f75d4ef7dcbe368e8f7` |
| apps/desktop/src/main/remote-host.test.ts | `15361ad8c9928d3ff275aec49254ceb2e6bc5831` | `48db3199f2c87b59707eed1e30607d8d0734c7b9` |

**O2: closed by `4cb1746a`.** App captures the originating space ID, pane ID
and session ID alongside the navigation generation when recording the outcome
(`App.tsx:900-904`). The consuming effect compares all four, includes the
space/layout in its dependencies and discards a mismatched pending handoff
(`App.tsx:1136-1150`). A wheel-only space switch now changes a validated owner
field even without a global input-generation event. The effect no longer uses
an arbitrary newly selected space/pane. A new result with null project ID clears
pending onboarding explicitly. The established normal draft/receipt lifecycle
is unchanged.

**O1: partially corrected by `4cb1746a`, fully closed for the identified refresh
ordering race by `da40bbef`.** App now waits for `inventoryReady` and an exact
selected-project entry in the local catalog (`App.tsx:1144`) before selecting
the normal repository group. This prevents project-list-first fallback identity.
Inspection of the unchanged provider exposed a remaining gap at that intermediate
target: readiness could remain true from an earlier refresh while `setLocal`
committed ahead of delayed remote metadata. The local canonical group could
still freeze without its permitted remote checkout.

The final one-line change resets readiness immediately after incrementing the
inventory revision (`use-machines.tsx:105-106`). Its existing local and remote
metadata commits are gated by that revision; only the current revision's complete
`Promise.allSettled` can publish readiness (`use-machines.tsx:107-154`). Thus the
local snapshot alone cannot release the onboarding effect while the same refresh's
successful remote inventory is pending. Superseded responses cannot release it,
and a failed/missing local catalog cannot pass the exact-project gate. No
resource sampling, host substitution, grant, selection, draft ID, workspace lock
or receipt behavior changes in this readiness reset. Refused/unavailable remote
metadata still grants no authority; this is not a guarantee about future host
connections or remote projects imported after the captured snapshot.

The host test's final helper accepts either the legacy remote-operation schema
or the separately negotiated Machines extension-operation schema. It validates
the advertised vocabulary without changing runtime capability negotiation or
grant enforcement. Only those two runtime follow-up diffs and this test diff
exist between the initial and final target; both complete patches were inspected.

## Other reviewed behavior

- `onboarding-completion.ts:43-91` now performs only selected `project.open`
  operations and settings save, returning `sessionId:null` and an optional
  project ID. The removed eager `session.create` has no substitute creation
  call. Failed imports/save never publish a successful outcome; path caching,
  the shared pending promise and cached completed result retain retry behavior.
- The landing effect (`App.tsx:752-754`) suppresses automatic Aria creation for
  this outcome. The outcome effect reloads sessions as metadata; it selects a
  session only when the result actually has a non-null session ID, which the
  new completion path never supplies. Its callbacks are stable at this target.
  The pending draft clears before normal draft opening. No independent duplicate
  from ordinary completion/save retries was identified.
- The handoff checks both `checkout.local` and exact project ID. Equal remote
  IDs or repository presentation identity cannot authorize a remote operation.
  It requests `initialHostId:'local'`; a new draft does not silently apply Auto
  or a remembered remote host. Existing original attempts take precedence.
- `ProjectDraftPane.tsx:53-71` caches clients by draft and selected host; only
  the explicit local arm probes `machines.localSnapshot`. Remote catalogs and
  workspaces use the fixed remote facade. Errors do not create a local client
  or substitute another host. O1 concerns stale eligibility, not host fallback.
- `ProjectDraft.tsx:61-112,168-176,184-247` restores exact draft/group attempts
  and saved host/workspace choices, locks machine selection for a workspace
  lock, pending/original attempt or corrupt receipt, and persists the original
  attempt before first-Send creation. It freezes the chosen host/model, verifies
  the returned owner, and stages/prompts through the captured client. Unknown
  outcomes use original read-only checks, not automatic replay.
- Remote draft state/receipts remain keyed by machine and draft; stage/prompt
  reject a different owner. Local first Send continues the normal
  `useSessionStart.createDraft` creation/reuse, occupancy and unknown-start
  guards. Opening the client draft alone invokes neither path.
- Setup re-entry keeps Shell mounted (`OnboardingGate.tsx:120-124`) and defaults
  to no new chat. Leaving it supplies null project/session IDs; its metadata
  refresh does not discard an established draft/session. Pending-generation
  fencing covers its ordinary pointer/keyboard entry and exit as above. A saved
  workspace lock remains tied to the draft ID and is restored by ProjectDraft;
  no new onboarding code removes that choice or its original attempt.
- `OnboardingReady` changes the label to "Open a new chat". Updated completion
  and Wizard assertions explicitly expect zero setup session creates. The other
  test changes adjust scoped RPC arguments and validate advertised remote
  operation names against the contract, including the final legacy/extension
  helper correction above. They change no runtime grant behavior.

## Unchanged authority boundary and verification limits

Main Machines, registry, network and remote-host source are byte-identical from
the baseline; verified blobs respectively are
`f12b34a18848743326aa77b3bf14cd7251c611f1`,
`093f6a3d56bfb87e2ea28c54f414fc487b275b37`,
`137f014e2eea13fa1d66144b94e562655560b9d1`, and
`e11780109b24d47410b6b944a78464b5d404d04a`.
The remote gateway remains `609b2e1654a4ce770e346ea4f53322975a5f2a4d`.
The complete five-file final runtime delta establishes that pairing, grants,
credentials, key/pin handling, signed route authority, host workspace tokens,
finite remote dispatch and receipts were not changed by this correction.

[machines-t3-security-final.md](machines-t3-security-final.md) and
[machines-final-delta-security.md](machines-final-delta-security.md) remain the
controlling prior bounded security evidence. Their executed proofs belong to
those reviewers and checkpoints; none is claimed as newly run here. This
review independently inspected Git patches, blobs, call sites and surrounding
source. Initial `git diff --check e97d3a7a..HEAD`, follow-up
`git diff --check b461c4ff..da40bbef` and baseline/follow-up ancestry checks passed.
No tests, builds, broad checks or heavy lease were run/acquired. Parent full
checks and the other worktree's App fixtures are not certified by this report.

All prior explicit limitations remain:

- Windows publication proofs do not establish directory fsync, power-loss/crash
  durability, hardlink availability, external mutation or deletion of both
  identity/anchor files. Unique temporary files are nonauthoritative.
  Cross-runtime desktop/headless profile-owner locking remains unimplemented.
- Real DPAPI/Electron safeStorage, macOS Keychain and Linux Secret Service
  restart/unavailable-keyring behavior, retained ID/key/pin and durable withdrawal
  remain platform gates; fixture AES-GCM does not verify OS keyrings.
- Two real desktops on one tailnet and iPhone Safari/installed PWA still require
  TLS/DNS/TCP destination checks, owned non-443 Serve, both pairing directions,
  fallback/cooldown/move-back, storage/reconnect, sleep/wake and network/ACL/revoke
  checks. No real Tailscale/mobile hardware was used here.
- Real providers/PTYs, terminal/device withdrawal, signed lease expiry,
  shutdown/descendant cleanup with F containment and actual split-pane/terminal
  DOM/native interaction remain gates. Private Connect registration/renewal,
  project refresh/revoke, incompatible binaries and manual-update UX remain
  unverified. Neither wheel nor onboarding DOM interaction was executed here.
- Bounded receipts do not promise unlimited exactly-once after a forgotten UUID.
  Unknown outcomes remain read-only. Route high-water durability under backward
  clocks and failed revocation persistence retain the prior stated limits.
- Headless services/management-socket permissions, cross-runtime owner locks
  and updater trial/rollback remain deferred capabilities requiring fresh review
  if implemented. This correction implements no headless/updater runtime.

Only this report was authored. No runtime edits, automatic C: checkout, other
worktree, user checkout, live app/profile/settings, Tailscale changes, push/PR or
delegation occurred. No new model/effort/permission launch was made; this existing
session used its provided unrestricted filesystem permission profile. Later
runtime changes require a new comparison against final target `da40bbef` above.
