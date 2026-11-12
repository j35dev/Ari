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

## Fresh core review, 2026-11-12

Sole replacement worker in the existing core worktree, starting at `8471f3f3`.
Reviewed the actual branch history and S1 independent-origin / S6 no-resend fixes.
The fresh review found that failed credential encryption or registry persistence
could leave a generated key or replacement device id active in memory. Credential
updates now become active only after successful sealed persistence. Adversarial
tests cover both failure seams and preserve the original durable credential.
Additional shared tests reject absent, unreachable and malformed command receipts
without resending the original mutation. Check results will be appended after the
coordinated focused validation.

Integration must preserve A's current Tailscale RPC changes in `rpc.ts`: constructor
`profileDir`, enable `params`, the startup/enable `resume` calls and disable result
preservation. Core is based on the older snapshot; those differences are not core
edits to cherry-pick or intended reversions. Grants authorization remains B-owned.

### Fresh verification and security disposition

All commands used the current coordinator runner, with committed checkpoints,
two resource slots only when admitted, D: temp/cache paths and one Vitest worker.
No resource floor failure, killed process, OOM, install, live network/settings/device
mutation, push or PR occurred.

| Focused check                                                                          | Result                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Desktop Machines, RemoteService, host, files, terminals, fork, integration and catalog | 128 passed, 1 skipped; 66.09s                    |
| Final Machines safety and real two-engine/two-gateway proof                            | 19 passed; 16.67s                                |
| Final RemoteService including corrupt identity and first-write failure                 | 27 passed in the two-file run                    |
| Remote gateway package, shared client, remote/Machines contracts and mobile session    | 244 passed; 13.46s                               |
| Shared/mobile session after lint helper cleanup                                        | 55 passed; 6.93s                                 |
| Final valid-empty-history restart/one-dispatch fixture                                 | 1 passed; 2.29s                                  |
| Contracts, remote-client, remote-gateway, desktop and mobile typecheck                 | Passed across scoped invocations                 |
| Scoped lint over core/client/contracts/gateway identity and mobile adapters            | Passed after correcting the three reported files |

The one platform skip is the Windows short-name fixture when the temporary
volume does not expose the required 8.3 aliases. New-test failures were a wrong
local `session.list` argument (`{}` instead of `undefined`), the identity test's
untyped JSON, and nullable SessionStore test assertions; all were corrected.
Lint cleanup uses typed request URL/body helpers and mock references, preserves
the receipt assertions, and documents why raw transport causes must not cross
the sanitized Electron IPC rejection.

S1 is covered by the anonymous copied-ID endpoint test and an additional actual
two-engine/two-gateway case where both hosts advertise the same public machine
id but require distinct keys and independent approvals. Revoking one device
leaves the other host connected. Stored credentials remain sealed and scoped
to the original independently paired origin.

S6 shared reconciliation maps every nonauthoritative receipt failure to keyed
`unreachable`, including revocation and unsupported capability, so first-send
UI refusal handling cannot discard an originally accepted command. Tests cover
missing/conflicting/internal/unreachable/revoked/incompatible lookup errors and
malformed results, with exactly one mutation. The actual host fixture loses a
successful create response, replaces history with valid `[]`, restarts its
engine/gateway, and proves read-only reconciliation without a second dispatch.
B owns damaged-restore/failed-persistence/capacity refusal; the fixture accepts
legacy `not_found` or hardened `conflict` on missing status.

Fresh safety fixes also make credential publication transactional, negotiate
before token-renewal command retries, clear stale tokens/capabilities/grants on
refusal, contain unreadable Machines registry initialization, and contain failed
host identity loading/persistence. Local startup survives both identity boundaries,
existing files are preserved, machine operations fail closed, and unavailable
host identity prevents both private and managed listeners. No grant authorization
policy was edited.

The existing lifecycle proof covers pairing/confirmation/host approval, projects
and sessions, create/deduplication, prompt/journal stream, approval option, stop,
client and host restart, replay, revocation/removal and incompatible negotiation.
Host/file/terminal/fork/integration/catalog suites exercise the broader validated
allowlist and project/terminal scopes. B's all-project and signed-lease changes
still require the coordinator's exact merged snapshot checks.

### Exact integration handoff

Reviewed against `feat/machines` `3be4d6fc`, with core code at `53f1320c`.
The following 30 commits are the ordered `git cherry` plus list. Already
integrated shared commits `fa7dd3a9`, `6ffb3874` and `b0bb6ddb` are excluded.
This final evidence commit follows the listed code commits.

```text
bee71d794a32fff97dd38c7e1468f2544e5d9277
f14638723de9ca7d000532e847f615cd2c4b67fa
6e5e75040910b4d6130b59777a5acba0e66c1939
04d6ec1638404bde4aadd864d8f1fbb3ce63f8ef
f24a49bb966809b58fe4ebaf89ae8e5cf6df4e91
7119a5a61cfd02b8db73fea54ea8c1b88f0c1b3c
02158cd79be05914d57faf396690c95064c936c5
4b8206dab6b9125b327b60695d4308fcc2cc7ec7
bdc4f70f3acb8c683a2bd8fcecc906509937bb8b
ad7c4240510dd5bdc1f1a973c3739cf5db264109
51d0d807e78298266fd1d2b3a2a38191c3dd74b4
b737d2f946bec8bbdda7d1734944f233ecfac361
23ba62d100cc242e2ad8b1c8e7ae8b61adf6b93a
c403f50ae85f4225dc1db1e3e43fbab96f665cba
8471f3f30d5ab01779ce15272fc5951d5e14a4fe
a5600bf825a418cac761d0af93543e4e9c85921a
870022b0057cd51aba57ea02f5e45e290a2c786e
438180bff53e39a2d9a5aa563a5a18c682964520
7d18bb952b7f5169cc393af6637ce8d859daf902
1c285cf4b13f241ee7f3bd67082a11267ee6d823
2d1e62755a33767d53f0b9e4a47506522f3ae996
d4be8dbececefc74f115b17fe5a96a4fdda397e5
23882f50830e36c3a855b0c95faf4d196dffbc76
1d541ade332b42efebfa6a76ff004a374b0aca41
f6fb1fc690ef43705d9b40ccbb58d9cb025aab8c
32ae6d34de3898f2f61919276cb5e2c0ec99253f
1fd55aeeac9d563801e54f3b8c60c2a24ab0df67
e24656f4c6aa79a88c646a63f95d8e5c15e9442e
bfd720a50ae7ddb4781ed43a7f686d72fda6fe01
53f1320c5449126210d6e62acc91085080ac23be
```

Preserve A's `rpc.ts` profileDir, enable params, resume calls and disable result.
Union B's lifecycle/persistence changes with core's identity fields/constructor
and start guards in `remote.ts`, and retain both test sets. Gateway identity
`publicInfo` changes coexist with B's strict restore validation, pinned-capacity
admission, uncertain missing-status response and grant/lease authorization.
Use core's latest shared-client/contracts/package metadata/mobile compatibility
adapters. Do not reintroduce anonymous route merging or receipt resubmission.

No known core-specific safety issue remains from this review. Integrated wide
checks/builds and the independent final security snapshot review belong to the
coordinator. Hardware/service gates above remain unverified. Protocol v1 has
bounded retained receipts: arbitrary direct replay of a very old forgotten key
by an old cached client cannot be certified exactly-once without a new negotiated
reservation/epoch protocol. Independent origins have no credential failover.
