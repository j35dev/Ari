# Machines parity implementation freeze

2026-11-12. This is the coordinator's accepted implementation boundary, following
the matrix in `docs/design/machines.md` and the host, session and shell research
notes. The latest `machines-t3-parity.md` brief controls product behavior. The
research notes identify existing engine entry points; they are not competing
contracts. Changes to these boundaries require coordination before shared edits.

## Execution and identity

Pairing is one-way. Settings > Machines is outbound access; Mobile access lists
incoming devices. There is no machine group, reverse approval, transitive grant,
implicit worker peer link, cloning, session migration or local execution fallback.

Repository identity selects valid network fetch remotes in order upstream,
origin, then lexicographically first other name. The normalized canonical key
uses host/repository path across HTTPS, SSH and SCP forms, lowercases, removes
credentials, query/fragment, trailing slash and .git. Local/file/UNC/relative
remotes have no shared identity. Unknown hosts retain their literal hostname;
forge aliases require explicit tested rewrites, never DNS inference. A differing
origin supplies the fork group key and label. Correlation grants no authority.
Multiple host checkouts retain separate project IDs and require a checkout
choice. Identity changes never rewrite a session's host or receipts.

## Compatibility and authenticated wire

Keep the current gateway.info.capabilities legacy vocabulary byte-for-byte as
an operation set. New features are advertised in optional machinesExtensions,
with version 1 and an explicit operation list. Cached mobile Zod readers may
ignore the new field; no existing mobile operation/result changes. New desktop
clients gate extensions explicitly. Unknown public ID/version cannot poison
route fallback. Only incompatibility proved by the pinned host stops the walk.

The host owner defines strict, bounded schemas/results for the following narrow
extensions in remote.ts (or a separately exported desktop schema imported there):

- project.catalog: authorized projects, saved default agent, safe repository
  identity, checkout status; no absolute paths or raw remote URLs.
- host.resources: sampledAt, available/unavailable, CPU utilization fraction,
  CPU count, available/total memory bytes and short unavailable reason.
- host.permissions: the effective caller's project scope, terminal grant and
  managed lease expiry; no other devices or client-supplied device ID.
- host.version: Ari/protocol version, desktop/headless, safe update status and
  manual guidance. Update execution remains deferred pending core completion.
- session.desktop.get: normal session/summary/context/runtime metadata, pending
  requests and tasks, liveTurnId; no raw provider credential/session identifier.
- session.desktop.create: receipted actual host creation using the existing root
  workspace occupancy/isolation policy, host project ID, catalog selection and
  validated host branch/worktree token. No client filesystem path authority.
- project.workspaces: bounded host-issued checkout/branch/worktree options.
- session.dequeue, session.provider.switch, session.stopChildren,
  session.resume.get/schedule/cancel, plan.get, changes.turn/turnFile,
  files.index, pastes.stage, and attachment-aware steer with real host rejection
  when the live provider cannot steer images.
- scm.desktop.summary/status/review: session-scoped projections into the normal
  SCM read DTOs. No broad SCM write tunnel. Preserve reviewed changes.preview /
  integrate as the explicitly snapshot-checked integration action.

All mutations retain strict original clientCommandId/idempotencyKey envelopes
and operation-specific result validation. Unknown outcomes are status-only,
including missing/expired receipts, thrown conflicts, bad result shapes, revoked
lookup or post-effect journal failures. Never turn receipt recovery into resend.
Gateway admission and delivery recheck effective grant/Connect lease. Host
callbacks resolve sessions/workspaces and descendants; requests cannot supply
caller permissions, arbitrary checkpoints, paths, settings or provider secrets.

Host local metadata uses the same readers through a focused
machines.localSnapshot RPC registered by the host owner. Its result contains
local identity/catalog/resources/version/preferences-ready metadata, rather
than exposing local privileged RPC remotely. Existing machines.query/command
carry the extended strict queries/envelopes. The route owner owns machines.ts;
the host owner coordinates localSnapshot schema addition as a separate hunk.

## Desktop replay

Negotiate events.desktop.subscribe separately from mobile events.subscribe.
Absent fromSeq requests full history including seq 0; supplied fromSeq requests
strictly later events. Frame type events.desktop.frame has start, chunk,
terminal and live variants. Start declares full/resume and high-water mark;
terminal always declares complete/incomplete, seq and actual liveTurnId, including
empty history or no-new-events resume. Typed journal events are bounded per
chunk; there is no 2,000-event history cap or whole-journal materialization.

Subscribe live before reading the high-water mark, buffer later events and drain
once in order. Sample runtime/barrier consistently so a terminal cannot clear a
newer buffered turn. Async engine range reading must report corruption/gaps/I/O
failure as incomplete, support cancellation and backpressure, and bound buffered
live events/bytes/time. Slow-client overflow requires incomplete/resync, never
silent row loss. Auth failure stops private delivery. Stream adapters capture
immutable machine, session and connection/subscription generation.

## Renderer interface and first-send draft

The session owner exports these seams from
renderer/src/features/session/session-client.tsx:

```ts
type SessionScope =
  | { kind: 'local'; sessionId: string }
  | { kind: 'remote'; machineId: string; sessionId: string }
sessionViewKey(scope: SessionScope): string
parseSessionViewKey(key: string): SessionScope | null
createSessionClient(scope: SessionScope): SessionClient
useSessionClient(): SessionClient
SessionClientProvider
```

Local existing IDs retain their keys. Remote keys encode the exact JSON tuple
of client-registry machine ID and wire session ID, not a display name, origin,
public descriptor or repository group. Unknown keys never become local IDs.
SessionClient exposes the normal rpc.invoke/rpc.subscribe typed surface plus
scope, viewKey, availability/readOnly, capability reason and receipt-status
helpers. Its remote adapter explicitly maps allowed operations and rejects all
others; there is no generic host invoke or global-local fallback. Tools can use
the same context without inventing a separate remote interface. The SessionView
wrapper accepts optional scope, installs the provider, and uses the view key for
all UI caches while retaining wire IDs in host events/messages.

The session owner publishes a typed host draft facade in the same module (or
session-draft-client.ts) for catalog/workspaces, create, stage, first prompt and
status checks. The shell owns actual project draft UI using normal Composer,
not a synthetic SessionView with a fake durable ID. Project selection creates
only client draft state. First send freezes exact host/project/catalog/checkout
and original creation receipt; successful creation hands its SessionScope to
normal SessionView. Uncertain create locks the draft and remains status-only.
Confirmed creation followed by uncertain prompt does not create again. File
bytes remain draft-local until creation/staging; staged/uncertain work locks host.

Composer accepts a below-controls ReactNode seam from shell and a supplied safe
host catalog/readiness seam. Session owner supplies those data interfaces; shell
owns Composer/ModelSelector edits and new draft surface, existing SessionView
belongs to session owner. Existing sessions and Aria never show machine picker.

Auto is available but off by default. Eligible hosts are connected, compatible,
have this checkout group, usable catalog and fresh authenticated resource sample.
This PC participates. Manual only is excluded. Prefer/Normal/Less often are
ordered preference tiers among nonbusy eligible hosts; rank within tier by CPU
and available memory, with deterministic tie-break. Missing/stale data or all
busy requires manual selection. Define/document tested busy/freshness thresholds
in shell policy. A draft's resolved host/reason remains stable until user selects
Auto again or a concrete host; branch/worktree/staging locks it. Revalidate before
dispatch, never queue or choose another host silently.

Offline/incompatible retains bounded last-known authorized presentation in the
normal view, labelled read-only with reconnect. Explicit revoke/removal/identity
mismatch invalidates scoped writers/subscriptions and purges host presentation,
including watched stores; user drafts and unknown receipts stay in original
scope. Cached metadata/resources are never authorization or fresh after restart.

## Routes and credential reuse

Keep registry IDs and independently approved original credential slots. Pin a
persistent sealed host signing key only through the already approved origin.
Learn routes only from an authenticated complete signed host manifest. Each
candidate must prove pinned host identity with a fresh client nonce and exact
normalized route audience before any device proof/bearer reaches it. Original
bearers never cross origins; grant/device/audience-bound single-use challenges
issue short-lived route-specific tokens. HTTPS credentials never cross HTTP.

The host signs only served exposures it owns, derived from verified configured
gateway/Tailscale mapping. allowedOrigins is request-origin policy and is NOT
served-route authority. Do not reflect Host/X-Forwarded/client audience into a
manifest/proof. Production retains verified Tailscale HTTPS, DNS/TCP pinning,
no redirects or downgrade; explicit loopback is test-only. Legacy hosts remain
independently paired per origin. Missing/corrupt signing identity blocks reuse
and hosting, preserves data, and never silently resets trust/plaintext storage.

Routes are ordered, manual/learned tagged; manual entries survive manifest
refresh, disappeared learned entries do not. Learned entries reorder but cannot
be removed. Authenticated prechecks on network/focus/minute permit move-back
with cooldown. Lifecycle guards ignore stale completion/rotation. Route changes
preserve UI ownership only after pinned identity/credential checks. Independent
fresh security review must certify this mechanism before completion.

## Ownership and integration

- Host owner: remote extension contracts, host.ts, desktop replay sections of
  gateway/ws, engine range reader, remote-host.ts and narrow host read/create
  adapters, remote.ts dependency wiring and rpc.ts host callback/localSnapshot
  registration. Preserve all A/B/S1-S9 sections. No registry/renderer edits.
- Routes owner: new route-auth schema/module, gateway descriptor/challenge
  sections, pairing audience additions, sealed host signing identity, machine
  registry/network/service/preferences, machines.ts and shared client route
  handshake/subscription forwarding. Coordinate touched gateway/rpc hunks.
- Session owner: session client/draft facade, SessionView/title/resume/plan,
  transcript/history/attachment/diff/result cards, keep-alive, scoped drafts and
  recovery helpers. No App/Sidebar/Composer/normal tools edits.
- Shell owner: App/Sidebar/navigation/activity/splits metadata, launcher/Welcome
  draft, Composer/ModelSelector seams, machine inventory/grouping/picker/settings,
  preferences/Auto, shell tests/screenshots. No existing SessionView/tools.
- Coordinator: normal files/Changes/terminal components and stores through the
  shared SessionClient context; integration, security, final proofs and docs.

Workers author in their assigned existing D: worktrees, one active session per
worktree. Preserve/commit interrupted notes first; merge the integration freeze
before implementation. Heavy installs/builds/checks use run-heavy.mjs, below
normal, D: caches and one test worker; dev already holds one slot. No user
checkout/live app/profile/Serve mutations, pushes or PRs. Contract-only work
does not justify idle waiting: publish the seam quickly and implement bounded
adapters, communicating exact signatures to peers.
