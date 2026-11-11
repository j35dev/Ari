# Machines and remote access

Status: shared contracts frozen for the first implementation, 2026-11-11.
Base: origin/main 6f018a75. Integration: feat/machines in D:/Projects/Ari-machines.

## Product and trust boundary

A machine is an Ari desktop hosting its existing loopback remote gateway. Every
desktop can host and control other desktops. Execution, terminals, repositories,
provider credentials and filesystem resolution always belong to the host. Remote
projects and sessions are addressed by (machineId, hostId), never translated into
local paths. Drafts, uncertain command receipts, subscriptions and attachments
must be scoped to the same pair and cleared from view when switching machines.

Tailscale is the production transport in this change; HTTP loopback is for tests.
Routes are a list so a future relay does not change ownership or pairing. No
Funnel, repository sync, local execution against remote files, load balancing,
headless host, or machine-to-machine Ari Connect implementation is included.
Each added origin is independently paired in this release. Anonymous identity
metadata cannot authorize sharing a paired credential with another origin.
Multi-route credential failover requires an authenticated host route binding
in a future protocol; matching public machine IDs is insufficient.

Host-approved P-256 device pairing, confirmation codes, revocation, short-lived
memory-only bearer tokens, strict origin checks and the remote operation allowlist
remain the security boundary. A desktop client cannot approve its own invitation.
Desktop private keys must be sealed with Electron safeStorage and never cross IPC;
if sealing is unavailable, fail clearly rather than persisting plaintext keys.
Phones keep their existing non-extractable IndexedDB keys. Terminal access is an
explicit per-device grant and runs as the host user.

## Frozen shared interfaces

The existing remote wire protocol remains version 1. Gateway information gains
optional machineId, name and ariVersion fields, with existing protocolVersion and
capabilities. Add a small unauthenticated GET /api/identity with only these fields
and capability names; it must not expose paths, project names, session data,
provider inventories or device records. Unknown versions are rejected before
pairing/commands. Missing capabilities produce a named unsupported_capability
failure. Old info responses remain readable, with a clear legacy identity label.
Machine identity is persisted in the host profile and survives a restart.

@ari/remote-client extracts GatewayClient and the transport-independent session
authorization/reconnect behavior from mobile. Preserve compatibility re-exports
at the mobile import paths. Browser storage and Connect broker coordination stay
adapters, not dependencies of the shared transport. Core owns package metadata
and lockfile changes; other workers report dependency needs to the coordinator.

Core defines @ari/contracts/machines with:

- MachineRoute: { kind: 'tailscale' | 'loopback', origin: string }.
- MachineView: { id, name, routes, status, identity, lastSeenAt, error, allowTerminal };
  status is unpaired, pairing, connected, offline, revoked or incompatible.
  identity contains only the gateway's public information. Credentials are absent.
  allowTerminal comes from this authenticated device's grant, defaults false,
  and is never inferred from the host's public terminal capability.
- MachinePairingView: { machineId, status, confirmationCode, expiresAt, error }.
- MachineDiscovery: { name, routes, identity }; bounded peer probes, no automatic
  pairing, no scanning the public internet, no redirects to arbitrary hosts.

Desktop RPC (core owns registration and contracts):

- machines.list(undefined) -> MachineView[]
- machines.discover(undefined) -> MachineDiscovery[]
- machines.add({ address, name? }) -> MachineView; address may be a tailnet URL
  or a pairing link, or loopback for tests. URL userinfo, unsafe protocols and
  non-tailnet production destinations are rejected.
- machines.pair({ machineId, displayName, invitationId?, code? }) -> MachinePairingView
- machines.pairStatus({ machineId }) -> MachinePairingView
- machines.connect({ machineId }) -> MachineView
- machines.rename({ machineId, name }) -> MachineView
- machines.remove({ machineId }) -> { removed: boolean }; close subscriptions,
  clear the local sealed credential, attempt self-revocation when reachable.
- machines.query({ machineId, query: RemoteQuery }) -> MachineOperationResult
- machines.command({ machineId, command: RemoteCommand }) -> MachineOperationResult
- stream machines.events with { machineId, sessionId, fromSeq? }; payload is
  { machineId, message: RemoteServerMessage }. Subscription and cleanup remain tied
  to their originating machine. Core may expose a narrow explicit subscription
  RPC if the current host stream dispatcher requires it, coordinated with UI.

Queries/commands are the existing validated remote allowlist. No generic local RPC
tunnel. UI must parse results with the existing remote schemas where available.
The renderer never receives device private keys, bearer tokens or Connect leases.
MachineOperationResult is { ok: true, result: unknown } or
{ ok: false, error: { code, message } }. Named remote failures retain their
codes across Electron IPC. Generic IPC failures remain thrown and uncertain;
clients preserve their original receipt and never automatically resubmit.

## Tailscale Serve contract (independent ship-first change)

Workstream A owns the remote.tailscale RPC extensions and TailscaleState fields.
enable accepts undefined or { httpsPort?, replace?: { origin, mountPath: '/',
target, kind: 'proxy' | 'path' | 'text' } }, where replacement carries the exact
observed conflicting mapping as a compare-and-swap confirmation. Replacement
defaults to the port in its origin and rejects a changed root, kind or target.
Default enable never overwrites a foreign mapping. Status exposes selected HTTPS
port (httpsPort), target, targetListening (boolean or null), owned, conflicts
({ origin, httpsPort, mountPath: string or null, target, kind: 'proxy' | 'path' |
'text' | 'tcp', listening: boolean or null }[]), and suggestedHttpsPort (number
or null). Additive status fields are optional for old fixtures, always emitted
by the implementation. Prefer a wholly free 8443 when 443 is foreign. Save a
separate ownership record with HTTPS port and
last gateway target under Ari's profile. A saved Ari mapping may be repaired after
the gateway port changes; target equality alone is insufficient to infer ownership.
Unknown/unreadable Serve shapes fail closed. Recheck immediately before mutation.

Use a different HTTPS port by default when 443 belongs to another application.
An explicit replacement names the existing address and target; preserve other
mounts on that port. Disable removes only Ari's own root mount, at its recorded
port, and never resets all Serve configuration. Pairing URLs, allowed origins and
the PWA follow the selected origin including its port. Root mounts avoid the
base-path complexities of installing and reconnecting a PWA under a subpath.
Test fake runners only; do not mutate the user's real Serve mapping.

## All projects and Ari Connect

New and migrated paired devices have allProjects: true. Keep projectIds as a
compatibility view where cheap, resolved against the host's current project list;
new projects are reachable without editing grants. Approval/device editing no
longer asks for project selection. Separate allowTerminal remains explicit.

Connect leases stay signed, short-lived and project-bound. The local all-project
device scope does not bypass the lease's projectIds or broker/account checks.
Request current registered project IDs on lease refresh where this repository
controls that request. A lease only authorizes its signed IDs, even for an
all-project device; a newly added project requires a fresh lease. No unsigned
wildcard, unbounded expiration or permissive migration of broker restrictions.
Report any required private Connect-service change rather than pretending to
verify/deploy that service here.

## UI design

Settings -> Machines supports manual add/link, discovered peers, host-approved
pairing with matching code, name, status/version, reconnect and removal. Hosting
uses the same Mobile access approval list, labelled for phones and computers.
Remote sidebar groups are labelled by machine. Remote new-session flow chooses
machine first, then that host's project, provider/model and permissions. Opening
a remote session must route every action, event, diff, file preview and granted
terminal to that host. Offline/incompatible states retain local drafts and avoid
automatic mutation retries. If the whole desktop view cannot be safely adapted,
deliver a clearly dedicated remote workspace with the full existing allowlist,
then report its differences from the normal desktop view explicitly.

Mobile audit covers navigation/home/session/composer/approvals/changes/files/
settings/empty/error/offline states. Keep Ari's existing UI tokens, fonts and
components, readable 360/390px layouts, safe areas and reachable composer. Add a
computer switcher with per-computer credentials, state/drafts/receipts and careful
cleanup. Same-origin Tailscale hosting is the default; cross-origin requests are
allowed only by the destination host's explicit origin policy. A phone may need
to navigate to the destination PWA origin rather than fetch another host from
the current origin; do not weaken origin checks to implement a switcher.
List every visible change and capture before/after light/dark screenshots at
both widths with deterministic fixtures and temporary profiles.

## Ownership and sequencing

Design and contract freeze precede Machines fan-out. A and F use branches from
origin/main. A owns tailscale.ts/tests, remote-origins behavior, Tailscale RPC
registration/types and its persistence fields. B owns pairing/grant migration,
gateway all-project authorization/Connect intersection, RemoteService grant
calls, mobile README, RemoteSettings/use-remote-access and their tests. C owns
remote-client, machines contracts/registry/discovery/desktop service + RPC,
gateway identity, and loopback integration tests. A/B/C touch distinct sections
of rpc.ts/settings.ts/remote.ts/gateway.ts; coordinator reviews and resolves
section-level conflicts. D owns desktop renderer Machines UI/sidebar/remote
workspace and settings navigation. E owns apps/mobile UI/state/tests, except the
client/session compatibility extraction owned by C. F owns its separate root
worktree/concurrency engine/CLI/desktop human path fix and is never merged into
feat/machines. Final security review is a separate report-only worker.

No worker installs or builds in the user's checkout or its managed C: worktree.
Each uses the precreated D: worktree, D: pnpm store/cache/temp. The resumed work
uses parallel authoring and one heavy worker/process at a time, serialized by
the atomic D:/Projects/Ari-machines-wt/.heavy.lock lease. Before every install, test, typecheck,
lint, build or browser capture, require at least 5GB free on C: and 1.5GB of
commit headroom (commit limit minus committed bytes). Available physical memory
is not a gate. Commit WIP before each long step, run tests with one worker and
no file parallelism, and run heavy processes below normal priority. Stop/report
a gate that remains failed for 15 minutes or a killed/OOM step without a retry
loop; transient gate failures wait two minutes and recheck. Heartbeat active
leases and reclaim locks stale for 30 minutes. The coordinator may do
read-only review, planning and git integration while the worker runs. Run wide
checks once, alone, after integration. Prefer fresh workers after pauses where
the implementation state is on disk, because old provider conversations have
failed intermittently on this machine. Confirm the old writer is stopped
before starting a replacement in its worktree.

## Verification and release gates

Capture main baseline before changed suites. Typecheck, lint, contracts,
gateway, engine, desktop and mobile tests with bounded concurrency, and desktop
and mobile production builds. Two loopback gateways backed by real engines must
pair/approve/list/create/prompt/stream/answer approval/stop/revoke, reconnect after
host restart and reject version mismatch. Mock provider drivers are appropriate;
mocking the engines or gateway transport is not this end-to-end proof.

Required hardware checks: two computers on one tailnet; iPhone on the tailnet;
non-443 phone URL/PWA install/pair/reconnect; host sleep/wake; network changes;
tailnet ACL denial; revocation with an open terminal; secure desktop key storage
across restarts; live managed Connect broker/tunnel lease refresh. Screenshots are
review evidence, not substitutes for hardware.

## Out-of-scope feasibility and nearby branches

Headless hosting is feasible by extracting gateway/engine bootstrap from
Electron; safe key storage, lifecycle, updater and provider login need a separate
design. Load balancing can select a host at creation; moving active sessions or
drafts requires explicit ownership and no implicit path substitution. Aria can
later coordinate through the machine registry and remote allowlist, but the CLI
currently targets one local engine. Ari Connect routes can implement the route
interface later with explicit broker/account device leases and origin checks.

feat/aria-experiment overlaps RemoteService host behavior in remote-host.ts and
settings schema/navigation/store; preserve its off-by-default experiment gates.
Compare f2591c40/d7399052 during review. Do not modify that worktree, paused
wip/aria-passthrough, marketing work or revenue-lab. No push or PR creation.
