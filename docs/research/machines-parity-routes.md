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
