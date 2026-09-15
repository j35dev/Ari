# Ari Remote — Design

**Date:** 2026-09-14
**Status:** Approved for implementation
**Scope:** Public Ari repository. The Ari Connect service (Clerk, D1, Cloudflare
provisioning, admin) is a separate private repository and is described here only
where the public side depends on its contract.

## Goal

Operate Ari from a phone: create sessions, prompt agents, answer approvals, and
review changes, while agents keep running on the desktop. Two independent
reachability modes — managed (Ari Connect + Cloudflare tunnel) and self-hosted
(Tailscale Serve). The desktop must never depend on the managed service.

## Why this is phased

The full handoff covers ten milestones across two repositories. They are built in
dependency order, and each phase is independently shippable and verifiable.

| Phase | Contents | Verifiable without owner inputs |
|---|---|---|
| P0 | Approval decision fidelity (upstream fix) | Yes |
| P1 | Remote gateway: transport, pairing, sessions, events, diffs | Yes |
| P2 | Mobile PWA (four destinations) | Yes |
| P3 | Tailscale Serve mode | Yes, with a phone on the tailnet |
| P4 | Managed tunnel client | No — needs a Cloudflare account |
| P5 | Ari Connect service (private repo) | No — needs domain, Clerk, D1 |

P0 is a prerequisite for P1's approval surface, and is already tracked upstream
as the open task M7.C. P1–P3 constitute the first releasable slice.

## P0 — Approval decision fidelity

**Problem.** The provider's real option list survives the round trip into Ari,
but the user's *answer* does not.

- `packages/providers/src/acp/acp-driver.ts:146-151` preserves
  `options: request.options` inside `summaryJson`.
- `packages/providers/src/acp/acp-driver.ts:41` narrows the answer to
  `AdapterApprovalDecision = 'allow' | 'deny' | 'always-allow'`.
- `acp-driver.ts:436-452` resolves that back to a concrete option with
  `optionFor(pending.options, kinds)`, which takes the **first match**.

When an agent advertises both a session-scoped and a prefix-scoped persistent
grant — Codex does, per the `PROGRESS.md` audit — `always-allow` silently
selects `allow_always`. The user's intent is guessed, and the journal
(`packages/contracts/src/events.ts`, `approval.responded { decision }`) persists
only the collapsed value, so the true choice is unrecoverable after replay.

**Required shape.** An approval response names an exact option.

- Requests carry the offered options as structured data, not an opaque
  `summaryJson` blob: `{ optionId, name, kind }[]`, order preserved.
- Responses carry the chosen `optionId`, validated against the options that were
  actually offered for that approval.
- The journal records the chosen `optionId` alongside the offered set.
- The adapter maps an `optionId` to the provider reply with no search or
  fallback. An unknown or stale `optionId` is rejected, never approximated.
- `autoAllows` keeps answering inline for Full-auto turns, still by explicit
  option selection rather than a preference list.

Backwards compatibility: the persisted journal gains fields, so `approval.requested`
and `approval.responded` readers tolerate events written before the change.

## P1 — Remote gateway

### Placement

An in-process module, `packages/remote-gateway`, constructed as
`createRemoteGateway(port, options)` where `port` is a narrow host interface.
`apps/desktop/src/main` supplies the port over the existing `Engine` and RPC
handlers.

Rejected: a separate process over `packages/engine/src/control-server.ts`. That
transport authenticates with per-session delegation tokens (`tokenFor(sessionId)`)
and lacks projects, approvals, questions, and any event stream; ADR §19 also
forbids exposing it. Also rejected: Electron `utilityProcess`, which would cost
headless testability under vitest for crash containment this workload does not
need — the injected-port boundary preserves the option to move later.

### Transport

- HTTP for commands, WebSocket for events, bound to loopback only.
- Default port chosen at startup; the bound port is published to the desktop host.
- Under Tailscale (P3) the gateway additionally serves the PWA build, making the
  PWA same-origin. Under managed Connect the PWA is served from
  `connect.<domain>` and the gateway from `<id>.<tunnel-domain>`, so requests are
  cross-origin. The API base URL is configurable and CORS/`Origin` handling is
  built in from the start, not retrofitted.

### Origin and credential rules (ADR §5)

- No wildcard CORS. An explicit allowlist of origins, matched exactly.
- WebSocket handshakes validate `Origin` with the same list.
- No cookies. Credentials travel in headers or the WebSocket subprotocol, never
  in a URL and never in a hostname label.
- Unauthenticated responses reveal no project names, file paths, or transcripts.

### Contract surface

A new `packages/contracts/src/remote.ts`, an explicit allowlist. Operations that
ADR §3 defers — `terminal.*`, `shell.*`, provider login, arbitrary filesystem
roots, API-key configuration, `fs.writeTextFile` — have no schema and therefore
no route. The gateway cannot perform what is not declared.

#### Gateway operations

| Group | Operations |
|---|---|
| Discovery | `gateway.info` (protocol version, capabilities) — unauthenticated, content-free |
| Pairing | `pairing.request`, `pairing.status`, `pairing.redeem` |
| Sessions | `session.list`, `session.get`, `session.create`, `session.archive` |
| Agent actions | `session.prompt`, `session.queue`, `session.steer`, `session.interrupt` |
| Human input | `approval.respond`, `input.respond` |
| Changes | `changes.files`, `changes.diff`, `changes.integrate` |
| Events | `events.snapshot`, `events.subscribe` (WS), `events.ack` |
| Devices | `device.list`, `device.revoke` |
| Commands | `command.status` (idempotency outcome lookup) |

Capabilities are published per provider and session. Unsupported operations are
absent from the capability set and rejected with `unsupported_capability` — never
inferred from a provider name.

Minting an invitation and approving a device are absent from the table on
purpose: both are the user's acts, performed at the desktop against the
in-process `PairingService`, not over the wire. If `pairing.approve` were
remotely reachable, whoever photographed the QR code could approve their own
device, and the confirmation code shown on both screens — the one control that
makes pairing a deliberate act — would be confirming nothing.

### Pairing and device authorization

Local pairing, independent of Ari Connect, because ADR §18 requires Tailscale
mode to work with the hosted service unreachable.

1. Desktop creates a single-use pairing invitation, 5-minute expiry, and renders a
   QR containing the gateway origin and invitation id in the URL **fragment**.
2. The client reads the fragment and clears it from the address bar immediately.
3. The client generates a non-extractable ECDSA P-256 key via Web Crypto, stored
   in IndexedDB.
4. The client posts its public key and a display name; the desktop shows the
   request with a short confirmation code derived from the public key, so the
   user can confirm the two screens refer to the same device.
5. The user selects which projects the device may reach, and approves.
6. The client redeems the invitation, proving possession of the private key by
   signing a server-issued nonce.
7. The gateway issues a short-lived operational session. The device key remains
   the durable credential; the session is not.

Pairing does not bypass approval, and an invitation is single-use: redemption is
atomic, and a second attempt fails closed.

### Sessions and commands

- Every mutation carries an idempotency key. The gateway persists the key, a
  payload fingerprint, and the outcome, and rejects reuse with a different
  payload. Records survive a desktop restart.
- Command acceptance and the resulting engine effect must not duplicate after a
  crash. Session creation and prompts are audited specifically, since those are
  the operations where a duplicate is visible to the user.
- On timeout the client queries `command.status` and reconciles; it never
  auto-replays a destructive action.

### Approvals and questions

Rendered from structured data (P0), showing the actual command or file detail and
the exact provider options with their real names and scopes. Several persistent
grants stay several buttons. An approval already answered elsewhere is reported
as such rather than silently failing. Permission escalation requires explicit
confirmation. The desktop's permission ceiling is authoritative; mobile cannot
raise it.

### Changes and integration

File list and per-file diffs load lazily. Integration binds to the reviewed
snapshot commit and rejects a stale or conflicting one with a reviewable error
and a refresh path. `session.integrate` already carries `snapshotCommit`,
`allowStale`, and an idempotency key. Destructive deletion and workspace cleanup
stay separate from interrupt and archive.

### Event stream and recovery

- Journal events carry a per-session monotonic `seq`
  (`packages/contracts/src/events.ts`), and `Engine.replaySession` plus
  `packages/engine/src/projection.ts` already exist.
- `events.snapshot` returns projected state plus the journal high-water mark it
  was taken at. Subscription then resumes from that `seq`, so there is no gap and
  no duplicate.
- Clients resume from their last acknowledged cursor. If replay is unavailable
  the gateway says so and the client re-snapshots.
- Project permissions are rechecked before replaying historical events, not only
  on connect.
- Buffers are bounded; a slow consumer is disconnected cleanly rather than
  allowed to grow the gateway's memory.

### User-visible connection states

Distinct states, never collapsed: connecting, connected, reconnecting,
authentication expired, access revoked, computer unreachable, unsupported
version. Last-seen time is shown. The UI does not claim the PC is asleep when it
only knows the gateway is unreachable.

## P2 — Mobile PWA

Four bottom navigation destinations, per ADR §13.

| Destination | Purpose |
|---|---|
| Now | Approvals, questions, failures, running sessions, recent completions |
| Sessions | Search, filters, project grouping, history |
| Projects | Authorized projects, new-session creation |
| Settings | Computer selection, connection, devices, appearance, account |

Selected computer and connection state stay visible near the top. Now is ordered
by need for action, not by recency or statistics.

Session detail has three views — Conversation, Changes, Details — with a
persistent composer offering explicit Send, Queue, and Interrupt. No action is
labelled "pause" unless the provider supports pause and resume.

Visual requirements: Geist typography, design-token colors from
`packages/ui/tokens.css` with no raw color literals, opaque layered surfaces,
16px form inputs, 44px minimum touch targets, light and dark themes, visible
keyboard focus, reduced-motion support, safe-area insets, screen-reader labels,
bottom sheets for secondary actions, no hover-only affordances, and no color-only
status. Streaming must not steal scroll position; a "Jump to latest" control
appears instead.

PWA lifecycle: stable manifest id and start URL, standalone display, maskable and
Apple touch icons, HTTPS, and a service worker caching a versioned app shell.
Auth callbacks, grants, API responses, transcripts, and diffs are excluded from
the cache. An update is never forced while the user is composing or confirming.
Incompatible gateway versions are detected before a command is sent.

Storage: unsent drafts may persist locally and are cleared on explicit sign-out
unless the user opts to keep them. Operational credentials live in memory and are
short-lived. Only device-key material persists.

## P3 — Tailscale mode

A desktop wizard that detects Tailscale, guides installation and sign-in if
absent, checks Serve and HTTPS prerequisites, configures a mapping for the
gateway without overwriting unrelated mappings, and displays the private HTTPS
URL with a pairing QR. Funnel is not used.

The same PWA build is served from the gateway and works with Clerk, Ari Connect,
the Connect backend, and the private repository all unavailable. Pairing is local
and uses separate credentials. Because the tailnet address is a different origin,
home-screen installation and pairing are separate from the managed origin, and
the switch is explicit — credentials are never transferred silently between
origins.

Membership suspension in Ari Connect does not affect Tailscale access to the
user's own computer.

## Security boundaries

- Cloudflare terminates TLS in the managed architecture. The product uses
  encrypted transport through Cloudflare, not end-to-end encryption, and is
  described that way.
- Device-key binding and desktop approval reduce credential replay and
  unauthorized enrolment. They do not make a compromised broker harmless.
- The public client is untrusted. Membership, quota, ownership, and authorization
  are enforced server-side in the Connect service, never inferred from client
  behavior. Loopback servers still validate every request.
- No secrets in the PWA bundle or the desktop build.
- The gateway never accepts an arbitrary URL as a computer endpoint, and never
  places a token in a hostname label.

## Data minimization

The gateway stores: the computer identity key, paired device public keys and
project scopes, revocation state, and command deduplication records. It does not
store provider API keys, repository contents, full transcripts, tool arguments,
or complete diffs beyond what the engine journal already holds.

## Testing

Per ADR §24, with `pnpm verify` green before every commit as AGENTS.md requires.

- **Authorization:** unpaired device denied; expired, replayed, and wrong-device
  invitations denied; key mismatch denied; project scope enforced on reads,
  writes, and replay; revocation closes live streams, not only new connections.
- **Commands:** duplicate prompts and session creations do not duplicate work;
  reuse of an idempotency key with a different payload is rejected; commands
  survive a desktop restart.
- **Events:** snapshot-then-subscribe has no gap and no duplicate; resume from
  cursor works; a slow consumer is disconnected; permission recheck applies to
  replay.
- **Approvals:** the exact chosen option is preserved end to end; several
  persistent grants stay distinct; a concurrent answer from the desktop is
  reported, not raced; permission mode never silently escalates.
- **Integration:** stale snapshot fails safely.
- **Transport:** real HTTP and WebSocket against the real gateway, not mocks.

Real-device verification on iPhone and Android, and packaged builds for Windows,
macOS, and Linux, are required before release and cannot be performed in this
environment; they are tracked as release gates.

## Blocked on owner authorization

Not started without explicit authorization, per ADR §25.4 and §25.7:

- Creating the private Ari Connect repository.
- Purchasing or configuring a domain.
- Creating Cloudflare resources or tokens.
- Creating a Clerk application and production OAuth configuration.
- Deploying anything, or enabling paid services.
- Sending invitations.

Required inputs when that work begins: owned domain (with a separate registrable
domain for tunnel endpoints), Cloudflare account id and a least-privilege
provisioning token, Clerk publishable and secret keys plus webhook signing
secret, and the owner's Clerk user id for bootstrap.

Nothing in P0–P3 depends on those inputs.

## Status after the P1–P3 slice

Implemented and verified by `pnpm verify` (typecheck, lint, tests for every
package). What exists now is the self-hosted path end to end: turn remote
access on in the desktop, expose it over Tailscale, pair a phone, drive
sessions from it.

**Gateway** (`packages/remote-gateway`)

- Loopback HTTP + WebSocket, exact origin allowlist, no wildcard and no
  cookies, `Origin` re-checked on the upgrade.
- Pairing: single-use five-minute invitations, a server-issued nonce signed by
  the device key, and atomic redemption. The nonce is bound to what it was
  issued for, so a proof cannot be moved to another invitation or device.
- Remembered devices: device records (id, name, project grants, public key)
  persist; bearer tokens do not, and age out. A desktop restart costs a phone
  a signature, not a new QR code.
- Revocation leaves a tombstone, so a revoked phone is told that rather than
  being treated as a stranger.
- Idempotency records persist, so a retry after a restart replays the recorded
  outcome instead of running a prompt twice.
- CORS: the allowed origin is echoed exactly, refusals carry nothing, and a
  preflight is answered from the allowlist.
- Optional `webRoot`: serves the built PWA from the same origin, refusing
  traversal, unknown extensions and anything outside the root, with hashed
  assets immutable and the shell, manifest and service worker `no-store`.

**Desktop** (`apps/desktop`)

- `RemoteService` owns the gateway's lifetime, the device records and the
  settings; the two decisions that must not be reachable over the wire (mint
  an invitation, approve a device) are in-process calls from the renderer.
- The host serves `session.*`, `approval.respond`, `input.respond`,
  `project.list` and `device.*` over the engine. `project.list` carries names
  and ids, never paths. `changes.*` is absent: nothing on the desktop produces
  a per-file change list, and the only integration that exists is the
  agent-to-agent one ADR §19 keeps off this surface.
- Settings → Remote access: enable/disable, the tailnet address and QR code,
  the pairing prompt with the confirmation code and per-project grants, device
  list with revocation, and the Tailscale Serve controls.

**Mobile** (`apps/mobile`)

- Installable PWA: four destinations, session detail with Conversation /
  Changes / Details, a composer with explicit Send, Queue, Steer and
  Interrupt, and approvals rendered from the provider's own options.
- Non-extractable device key in Web Crypto; bearer tokens in memory only.
- Connection states kept distinct (revoked, unknown device, version mismatch,
  unreachable, unpaired), each said in its own words.
- Versioned app shell cache; API routes, transcripts and diffs are never
  cached; an update waits for the user rather than reloading mid-prompt.
- Tested against a real gateway over real sockets, including the DER signature
  encoding and the lost-response retry path.

## Remaining before release

1. **Packaging.** `electron-builder` must copy `apps/mobile/dist` into
   `resources/mobile`, and the release workflow must build `@ari/mobile`
   before packing. Neither is done: `.github/` is orchestrator-only, and
   without the first the packaged app serves the API alone (`mobileWebRoot`
   returns undefined rather than guessing).
2. **Real devices.** iPhone Safari, iPhone installed, Android Chrome and
   Android installed, over cellular with the desktop on unrelated Wi-Fi, with
   lock/unlock and network switching. Cannot be performed in this environment.
3. **PNG icons.** The manifest ships SVG; iOS home-screen icons want PNG.
4. **Per-file changes.** `changes.files` and `changes.diff` need a desktop
   implementation over the session's workspace before the phone's Changes tab
   has anything to show, and guarded integration needs the same, bound to the
   reviewed snapshot.
5. **Managed mode (P4/P5).** Needs the owner inputs listed above.
