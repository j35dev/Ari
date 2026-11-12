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
