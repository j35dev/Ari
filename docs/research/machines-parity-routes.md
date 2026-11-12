# Machines routes implementation handoff

2026-11-12. Worktree `D:/Projects/Ari-machines-wt/parity-rework`, branch
`machines/parity-rework`. This implements the coordinator freeze, preserving
S1-S9 and one-way pairing. No reverse, group or transitive authority exists.

## Published renderer contract

`@ari/contracts/machines` exports `MachineAutoPreference`:
`prefer | normal | less-often | manual-only`. These are ordered tiers, not
numeric weights. `LOCAL_MACHINE_PREFERENCE_ID = 'local'` identifies This PC in
preferences. Missing tiers default to `normal`; Auto defaults off.

- `machines.preferences(undefined)` returns `MachinesPreferences`.
- `machines.setAuto({enabled})` returns the persisted preferences.
- `machines.setPreference({machineId, tier})` accepts a registry ID or `local`.
- `machines.rememberProjectHost({projectKey, machineId})` persists the explicit
  host choice, including `local`.
- Result: `{autoEnabled:boolean, hostTiers:Record<string,MachineAutoPreference>,
  projectHosts:Record<string,string>}`. This is client-local sealed-key-independent
  preference data, never permission or fresh resource authority.
- `machines.localSnapshot(undefined): MachinesLocalSnapshot` is registered by
  the host owner using its shared local readers; route owner only adds the RPC
  contract.

`MachineView` adds `effectiveRoute?:string|null`, `versionReady?:boolean`,
`permissionsReady?:boolean`, `projectIds?:string[]`, `autoPreference?:tier`.
Readiness is current authenticated connection state and defaults false after
restart. `MachineRoute` adds `source?:manual|learned` and
`credentialOrigin?:string`; origins are unique route keys and preserve order.
Missing source means manual for migration. Public metadata never grants access.

Routes RPCs: `machines.addRoute({machineId,address})`,
`machines.reorderRoutes({machineId,origins})`,
`machines.removeRoute({machineId,origin})` return `MachineView`;
`machines.precheck({machineId?})` returns `MachineView[]`. Reorder requires a
complete permutation. Learned routes cannot be removed. Session stream params
add `desktop?:true`; forwarding retains `{machineId,message}` with the host
`events.desktop.frame` payload and immutable subscription scope.

## Host wiring boundary

`@ari/remote-gateway/route-auth` exports `HostRouteSigner`,
`createHostRouteSigner`, and `RouteAuthority = {signer, servedOrigins:()=>
readonly string[], audience:()=>string|null}`. Gateway option is `routeAuthority`.
`servedOrigins` is exclusively a complete verified configured Serve exposure
list owned by this listener. `audience` is its single configured exact exposure,
not Host, X-Forwarded, request Origin, allowedOrigins or a client claim. Null or
multiple unidentifiable exposures disable reuse; do not infer authority.

`loadHostSigningIdentity(dir, hostId, secretBox)` seals the persistent P-256 key
and fails closed on missing keyring/corrupt identity. Host owner wires only these
signer dependencies in `remote.ts`, without taking route registry ownership.
Managed Connect listeners omit routeAuthority and retain their lease policy.

Candidate anonymous proof and challenge are signed with canonical
`routeSigningText`. Client pins a key only from an authenticated manifest on an
independently paired original origin. Fresh nonce, exact audience, host ID,
signature and expiry are checked before device proof leaves that origin. Original
bearers never cross origins. Candidate receives only an audience-bound challenge
signature and its own short-lived token; HTTPS never downgrades to HTTP.

## Verification status

Interrupted source is preserved in `32cf239b`; host schemas are integrated in
`227e3b61`. Implementation and focused tests follow this published seam. Final
independent security review and hardware proof belong to the coordinator.

## Main registration dependency (host owner)

`RemoteServiceDeps.routeSigning?: {secretBox:()=>SecretBox|null,
servedOrigins:()=>readonly string[]}` is the only added `remote.ts` dependency.
The direct gateway gets `routeAuthority`; managed Connect never does. Register
it using the same OS-backed `safeStorage` policy as Machines. Supply only
`origins.state().serving && origins.state().owned === true` verified exposure(s)
whose current mount targets this gateway. Persisted `allowedOrigins` entries
never qualify. If there is more than one exposure and ingress cannot be identified
from trusted listener configuration, the audience is null and reuse is disabled.
Host owner owns the small `rpc.ts` registration hunk; no host replay hunks are
changed here. `remote.ts` signer wiring is committed separately for cherry-pick.

Renderer focus/online events should call `machines.precheck({})`; the service
also prechecks every minute and gates move-back with a 60-second cooldown.

## Current implementation checkpoint

- `c2857460`: exact renderer preferences/routes/localSnapshot/desktop stream seam.
- `c1f4ac02`: gateway route authority, signed manifests/proofs/challenges and
  audience-bound short-lived route tokens; includes PairingService additions.
- `15763692`, `fdac2917`: shared verification/session handshake and v2 registry,
  ordered route service, persistent preferences and RPC registration.
- `00b3f6f7`: narrow `remote.ts` sealed signer dependency wiring. Main host owner
  still supplies `routeSigning` in `rpc.ts` using verified owned Serve state.
- `6b51b07d`, `0b9212b6`, `994ff451`, `2439d0fd`: missing-key anchor, pending
  lifecycle guards, typed stream scope, route token renewal and cursor-preserving
  subscription reconnect. No mutation resends; receipt keys stay unchanged.
- `bf26e65d`: allProjects included in route authorization and MachineView's
  current authenticated direct grant; managed authorization clears this flag.
- `772da0dd`: DNS/descriptor/proof deadlines <=2.5s; other operations retain 10s.
  Minute/focus/network prechecks can reconnect saved offline hosts; revoked and
  incompatible hosts require explicit reconnect.
- `ec6a27bd`, `ff8eb679`, `11152ed2`: focused route proof and scope fixtures and
  additive public desktop metadata assertion.

Host dependencies integrated without taking ownership: `85cbb36e` -> `227e3b61`,
`afe2da9e` -> `0361c6b6`, `9761a700` -> `86ad6ca0`. Gateway merge keeps the host's
capability filtering/replay/receipt changes and route owner's routeIdentity flag.
Do not cherry-pick these dependency copies twice if already on integration.

Completed validation under run-heavy gate, below-normal, D caches, one worker:

- Frozen install: passed, no lockfile change.
- Contracts, remote-client, remote-gateway typechecks: passed after host merge.
- First route/Machines suites: 27/27 passed before host adapter merge.
- Latest combined desktop check: routes **15/15 passed** (real two-listener
  fallback/move-back, signature/nonce/audience/expiry before device proof,
  all-project learned-route grants, anonymous privacy, replay resume scope,
  preferences and signing storage). Wider run: 73/77 passed.
- The old Machines public descriptor exact-key assertion needs the additive
  machinesExtensions field; updated in `11152ed2` and rerun pending.
- Three host-owned `remote.test.ts` terminal cases return 409 after host owner
  post-effect outcomeVisible recheck in gateway.ts; expected 200. The command's
  receipt must remain claimed. Route owner has not weakened this check.
- Focused main typecheck reports host-owned `remote-desktop-reads.ts:88` TS2488,
  spreading `ParsedDiff | files[]` from the host adapter. No route-owned errors
  were reported. Host owner must resolve this import dependency.

Focused final reruns/lint follow. Fresh independent integrated security review,
real tailnet/hardware and production rpc.ts served-exposure registration are
still required. No UI, app/profile/Serve mutation, push or PR occurred here.

## Final route-owner handoff

Final source/test head before this report: `630e0892`, branch
`machines/parity-rework`, worktree `D:/Projects/Ari-machines-wt/parity-rework`.
All authored source and tests are committed; no additional agents were launched.

Further accepted route slices:

- `833376ae`: removing a manual original address preserves the sealed original
  credential slot and pinned key. At least one route remains. Legacy unpinned
  hosts cannot transfer a credential slot. A host-reported removed manual address
  can subsequently return as a learned route; learned routes remain nonremovable.
  View readiness and terminal/project grants are false without a usable current
  connection. Self-revocation over a remaining pinned route uses route proof and
  a route-specific token, never the original bearer.
- `379ef67b`: only a fresh proof from the pinned host can stop fallback for
  protocol mismatch. A copied public ID/unsigned incompatible descriptor cannot.
- `3643b57d`: two-engine proof has a 90s bound for gated below-normal Windows
  execution; the successful final run completed in 15.28s.
- `630e0892`: legacy anonymous assertions retain exact minimal metadata keys,
  adding only the optional capability extension descriptor. No inventory is
  accepted. Gateway source publicInfo/replay remains the host owner's hunk.

The published MachineView also has `allProjects?:boolean`; it is current direct
caller metadata, not a public capability or authorization shortcut. Local Auto
preference uses the literal `local`, tiers remain ordered and Auto defaults off.

Final checks (all under run-heavy gate, D caches, below normal, one test worker,
no file parallelism):

| Check | Final result |
| --- | --- |
| Frozen pnpm install | Pass; no lockfile change |
| Contracts, remote-client, remote-gateway types | Pass |
| `tsconfig.machines-routes.json` service/signing/RPC/network/test types | Pass |
| Route-owned source lint (13 files) | Pass, zero warnings |
| Machines route proof + existing two-engine Machines tests | 36/36 pass (17 route + 19 existing) |
| Contracts suite | 224/224 pass |
| Shared remote-client suite | 24/24 pass |
| Remote-gateway suite | 182/182 pass |
| `git diff --check` | Pass |

These are focused checks, not the fresh independent security certification.
The wider wiring typecheck including host `remote.ts` remains blocked on
host-owned `remote-desktop-reads.ts:88` (ParsedDiff/files-array union). The earlier
combined `remote.test.ts` run had 3 terminal cases returning 409 after the host's
new post-effect visibility recheck; retain receipts and fix/verify the host
reader/test fixtures rather than weakening that recheck. Neither unresolved
host issue occurs in the successful two-real-engine Machines proof.

Host integration still must supply `RemoteServiceDeps.routeSigning` in rpc.ts
from OS-backed safeStorage and **owned verified serving exposure** state. No
fallback to allowedOrigins/clientOrigin/request headers is permitted. Direct
signer wiring is `00b3f6f7`; managed Connect omits route authority. Shell must call
`machines.precheck({})` on focus/network restoration; the main service already
runs minute prechecks and a 60-second move-back cooldown. Fresh independent
security review and real Tailscale/hardware verification remain coordinator work.

No installed app, real profile/settings/Serve, C: launcher, user UI worktree,
protected fix branch, push or PR was changed. Worktree and evidence are retained.

## Security corrections for review 3b7a2ad7

The latest `feat/machines` was merged first, fast-forwarding this branch to
`11f3fa00`. That baseline includes the host production route-signing registration
and later host fixes. The older handoff's missing production registration is
therefore historical; no signer, RPC, gateway, renderer or host hunks were changed
for these corrections.

Correction commits, in dependency order:

- `5fe6f67f`: `MachinesRegistry.learn` compares against the latest durable
  accepted report at commit time. Older issuedAt reports return the current record
  without a write, even when their signatures and wall-clock validity pass.
  Newer complete reports replace the learned origin set. Equal-time conflicts
  persist the intersection in `manifestOrigins`; either arrival order can narrow
  learned routes but cannot restore them. Existing v2 records default this field
  to null and use their saved signed report as the initial accepted set. The
  actual signed manifest is retained and the accepted intersection must be its
  subset. Manual routes, registry ID, host pin and the original sealed credential
  slot remain intact. A host needs a strictly newer issuedAt to expand an origin
  set after an equal-time conflict.
- `253f219b`: route attempts register before DNS/proof starts and capture the
  machine/origin generation. Membership changes invalidate affected generations,
  abort early attempts and pending connections, and drop affected active ones.
  Current membership and generation are re-read after async work and before
  authorization, negotiation and connection publication. Removal followed by
  adding the same origin cannot revive an old attempt. Reordering existing
  membership leaves its generation intact. Disposal and machine removal also
  abort early attempts. Ordered fallback can still use a current pinned route.
- `439fd021`: seven focused regression cases cover older valid report replay
  after restart with a byte-identical durable file; equal-time conflicts in both
  orders with reloads; manual-route/pin/credential preservation; removal and
  removal-plus-readdition while DNS waits; and valid proof/challenge responses
  held until after removal, with no stale authorization or bearer delivery.

Changed source/test files are `apps/desktop/src/main/machines-registry.ts`,
`apps/desktop/src/main/machines.ts`, and
`apps/desktop/src/main/machines-routes.test.ts`. This document is the only other
authored file. S1-S9, one-way pairing, original bearer isolation and mutation
receipt keys remain unchanged.

Executed correction checks under the shared run-heavy gate, below-normal,
D: caches, one test worker and no file parallelism:

| Check | Result |
| --- | --- |
| `machines-routes.test.ts` | 24/24 pass, including all seven new cases; 5.15s |
| `tsconfig.machines-routes.json` | Pass |
| ESLint on the three changed source/test files, zero warnings | Pass |
| `git diff --check` | Pass |

The earlier 36 Machines / 224 contracts / 24 client / 182 gateway evidence
remains attached to its original snapshot. Those broader suites were not rerun
and are not claimed as correction validation. Fresh independent review of the
final integrated correction SHA and real tailnet/hardware proof remain with the
coordinator. No new agents, live app/settings/Serve changes, push or PR occurred.
