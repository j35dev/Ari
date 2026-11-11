# Machines core implementation and evidence

Worktree: `D:/Projects/Ari-machines-wt/core`, branch `machines/core`.
Implementation session: codex / gpt-6.1-sol, xhigh, full permissions.
Date: 2026-11-11. This is implementation evidence, not a hardware release approval.

## Published interfaces

The shared extraction/contracts are `fa7dd3a9` and `6ffb3874`. The structured
operation result is the contract-only follow-up `b0bb6ddb`. The package-only
lifecycle cancellation follow-up is `4b8206da`. Published commits were preserved.
The initial uncommitted draft was saved before implementation or verification.

`@ari/contracts/machines` exports public identity, route, view, pairing and
discovery schemas/types, `machinesRpcParams`, `MachinesRpcResults`,
`machineEventsParamsSchema`, `machineEventsFrameSchema`,
`machineFailureSchema` and `machineOperationResultSchema` with their types.

`MachineView.allowTerminal` defaults false and comes only from authenticated
`device.authorize` results. An advertised `terminal.*` capability is never a grant.
`remoteSessionResultSchema` in `@ari/contracts/remote` validates the complete host
result: session, summary, sequence, messages, pending approvals/inputs and optional
child tasks/parent. Session summaries retain the existing RPC export; their schema
lives in the session module to avoid a remote/machines/RPC initialization cycle.

`@ari/remote-client` exports `GatewayClient`, `RemoteError`, `RemoteSession`,
`CLIENT_PROTOCOL_VERSION`, `SessionDeps`, `ConnectionState`, `DeviceCredential`
and `LeaseAdapter` at the root and relevant subpaths. Mobile import paths retain
the `GatewayClient` re-export and `MobileSession` adapter. IndexedDB storage,
per-origin keys, legacy storage migration and Connect broker adapters remain mobile
owned. Pairing checks protocol before request and again before redemption.
Version 1's mandatory anonymous handshake remains compatible with legacy info
responses that list only host capabilities.

| Desktop RPC                                                  | Result                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `machines.list(undefined)`                                   | `MachineView[]`                                              |
| `machines.discover(undefined)`                               | `MachineDiscovery[]`                                         |
| `machines.add({address,name?})`                              | `MachineView`                                                |
| `machines.pair({machineId,displayName,invitationId?,code?})` | `MachinePairingView`; host decision continues asynchronously |
| `machines.pairStatus({machineId})`                           | `MachinePairingView`                                         |
| `machines.connect({machineId})`                              | `MachineView`                                                |
| `machines.rename({machineId,name})`                          | `MachineView`                                                |
| `machines.remove({machineId})`                               | `{removed:boolean}`                                          |
| `machines.query({machineId,query:RemoteQuery})`              | `{ok:true,result}` or `{ok:false,error:{code,message}}`      |
| `machines.command({machineId,command:RemoteCommand})`        | Same structured result                                       |

Unknown IPC failures remain rejected with an uncertain outcome. Known failures,
including `command.status` not-found/conflict/unreachable, remain plain data across
Electron IPC. Command keys are preserved; Machines does not automatically resend
a mutation after a lost response. Receipt lookup is on the original machine.
The legacy wire result of `command.status` is itself an `{ok:true,result}` envelope.

Standard `stream.subscribe` uses `machines.events` with
`{machineId,sessionId,fromSeq?}` and emits `{machineId,message:RemoteServerMessage}`.
`machines.updates` emits `MachineView[]`. A registry subscription object identifies
its generation, so late errors and frames cannot reach a reused subscription id.
Removal/unsubscribe close their own sockets, including pending authorization.

## Trust and persistence

The main-process registry atomically persists public records and safeStorage-sealed
P-256 credentials. There is no plaintext/file-key fallback for desktop pairing.
Unavailable encryption and Linux `basic_text` storage refuse pairing. Failed
unlocks never install a partially loaded connection, allowing subsequent recovery
with the original key. Credential, token and lease data are absent from renderer
views. Tokens and leases live only in memory. Disconnect aborts each outstanding
operation's lifecycle signal; late authorizations/leases/results cannot restore
state, credentials or streams, including after a fresh reconnect.

Host identity lives separately in `remote/identity.json`, independent of gateway
port and process lifetime. `/info`, `gateway.info` and unauthenticated
`GET /api/identity` expose only machine id, name, app version, protocol version and
deduplicated implemented operation names. Supplied browser origins still follow
the host's exact origin policy.

Production routes require Tailscale HTTPS hostnames. DNS answers must be entirely
within Tailscale address ranges and are pinned into HTTP/TLS/WebSocket connections.
Redirects, URL userinfo, arbitrary paths/query strings and public/LAN destinations
are rejected. TLS verification remains enabled. Loopback HTTP requires an explicit
test dependency; production RPC registration never enables it. Discovery reads
`tailscale status --json`, considers bounded online peer routes, probes at most two
in parallel, and never pairs or scans subnets/public hosts. It tries 443 and 8443;
other configured ports can be added manually.

Security correction `02158cd7` removed public-identity route merging and failover.
Public identity can be copied by another endpoint and cannot authenticate a route
binding. Each new origin is a distinct independently paired record. The route list
remains forward-compatible, but saved credentials use only the original origin.
Authenticated route migration/failover requires a future host-binding protocol.

Machines service has no local Engine dependency. Commands, session ids, relative
file paths and attachment ids enter only the destination host's existing validated
remote allowlist. The renderer receives no local filesystem resolver or generic
`command.dispatch` tunnel through this service. Removal clears the sealed local
credential and attempts only this client's self-revocation at its saved origin,
including a remembered credential with no active bearer session.

## Verification

Every install/test/typecheck/format step used the shared `run-heavy.mjs` atomic
lock, D: cache/temp, below-normal priority, C: free-space and commit-headroom gates.
Tests used one worker with file parallelism disabled. No OOM/killed step occurred.

- Initial extraction: remote contracts and existing mobile session tests,
  **55 passed**, 6.41 seconds.
- Existing gateway, desktop RemoteService and mobile regressions in the initial
  core run: **122 passed**. The new proof initially failed its default one-second
  approval wait. Actual engine/git startup required a longer wait; a six-second
  assertion with accepted-command checks and diagnostic state resolved it.
- Two-gateway/core proof after that correction: **9 passed**, 8.75 seconds.
- RPC scope/generation, delayed authorization/unsubscribe/reuse, sealed-key
  recovery, contract and existing mobile checks: **55 passed**, 18.17 seconds.
- Final original-origin/copy-identity boundary, shared disconnect cancellation,
  two-engine proof and existing mobile session checks at `4b8206da`:
  **50 passed**, 20.62 seconds.
- Desktop typecheck passed during implementation. Final formatting, lint and
  typechecks are recorded in the completion report after they finish.

The main loopback proof uses two actual desktop `Engine` instances, two actual
`SessionStore` journals, git repositories and `RemoteHost` adapters, and two actual
HTTP/WebSocket gateways. Only the provider driver and OS-keyring seam are mocked;
the test uses real P-256 signatures and encrypted credential persistence. Both
hosts deliberately reuse `sess_same` to check machine ownership. It covers host
approval and matching confirmation code, project/session listing, create and
deduplication, prompt, real journal streaming, exact approval option, stop, client
restart and host restart, replay/reconnect, receipt persistence, independent
revocation/removal and incompatible protocol refusal before pairing mutation.

## Remaining release checks

The parent owns integrated wide lint/typecheck/tests and production builds once at
the end. No separate origin/main baseline was run by this worker; initial focused
verification was against the preserved extraction draft. No live Tailscale Serve,
running Ari, saved user settings, paired hardware or Connect broker was changed.

Hardware checks remain: two computers and iPhone on one tailnet; custom HTTPS port
and PWA install; sleep/wake/network changes and ACL denial; terminal revocation;
actual Electron safeStorage across restart; live managed Connect lease refresh.
Full terminal/fork/integration/file/attachment UI behavior belongs to existing host
adapters and renderer/mobile integration, not this loopback provider fixture.
