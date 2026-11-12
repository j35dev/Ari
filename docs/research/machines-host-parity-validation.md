# Machines host parity validation

2026-11-12. Host worktree: `D:/Projects/Ari-machines-wt/host-rework`, branch
`machines/host-rework`. Integrated coordinator snapshot `77c07e60`; source and
proof through `fac2ec89`. The preserved work was already committed as
`4f7125e4` and `ae024ae1` when the replacement worker inspected the worktree.
No worktree was discarded or recreated.

## Delivered host corrections

- `machines.localSnapshot` accepts optional `{ sampleResources?: boolean }`.
  Omitted/false returns an explicit unavailable sample with null timestamp and
  does not call CPU/memory readers. Explicit true requests the shared demand
  sampler. Direct and managed host reads retain authenticated `host.resources`.
- Production `RemoteService.routeSigning` uses the same secure storage policy as
  Machines: encryption must be available and Linux `basic_text` is refused.
  Served origins come only from current `origins.state()` when `serving` and
  `owned === true`, using its exact origin. Request-origin lists, HTTP headers
  and client-facing URLs confer no served-route authority.
- Strict journal replay now reads bounded blocks through one owned file handle.
  The previous stream destroy closed its numeric descriptor before the final
  buffered chunk was yielded. The range reader retains cancellation,
  backpressure, byte/count limits and explicit corruption/continuity failures.
- Normal SCM reads use typed `SourceControlHost.summary/status/review/diff`
  methods shared with local RPC registration. Remote callbacks no longer invoke
  the RPC registry. Existing snapshot cache and read cancellation remain shared.
- Desktop paths and repository keys reject control characters. Existing legacy
  operation names remain unchanged; desktop additions use `machinesExtensions`.

## Focused proof

The five desktop Node suites passed **87/87** at source `fac2ec89`:
`remote-desktop`, `remote-host-metadata`, `remote`, `root-concurrency`, and
`source-control-host`. One test worker, no file parallelism.

The two-host proof uses two actual `Engine`/`SessionStore` instances, separate
disk roots and actual loopback gateways. Both deliberately reuse wire session
ID `s`. Pairing to A creates no device on B; A's credential is refused by B.
Commands and replay mutate/read only their owning engine. A is closed and its
engine/store recreated against its saved journal; a newly restored pairing
service rejects the old ephemeral token and accepts a fresh signed remembered
device challenge. Resume retains A's transcript and immutable host ownership.
Revoking A's device does not affect the independently paired B device.

Replay coverage includes seq 0 and 2,406 records without `readAll`, zero-new
resume, explicit empty completion, corrupt/gapped prefix, awaited consumer
backpressure/cancellation, appends during replay drained once after the terminal,
actual runtime callback metadata, bounded live overflow and revoke fencing.
The overflow case injects bounded live callbacks during real range replay; it
does not claim to simulate a physical slow network. Runtime metadata coverage
uses a controlled live-turn callback.

Authenticated metadata coverage uses a real signed Connect lease, rather than
mistaking direct all-project pairing for a restricted grant. Catalog, resources,
permissions and version are private; signed project scope hides the private
project; lease expiry and revoke deny subsequent reads. Catalog output omits raw
repository paths and credential-bearing Git URLs. The public operation enum is
still the legacy vocabulary, with separate extension negotiation.

Repository fixtures cover SSH/HTTPS/SCP normalization, deterministic fallback
remotes, upstream plus a differing fork origin, equal origin/upstream, Azure's
explicit alias, unknown hostnames, local-only remotes, missing folders and common
Git configuration across worktrees. Checkout tokens reject other devices,
workspace modes and changed branch refs. The real remote first-send test also
passes a host-issued isolated-checkout commit through `prepareRootWorkspace` and
checks the resulting managed workspace's exact `baseCommit`.

Resource fixtures cover no constructor demand, shared concurrent measurement,
cache expiry, utilization fractions, byte units, counter resets/hotplug/invalid
readings and impossible memory values. Local inventory does not sample unless
explicitly requested. An invalid creation result after its journaled effect
leaves the original receipt claimed: repeating the same envelope and querying
its status never invoke creation again.

## Checks and limits

Focused typecheck passed with
`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.machines-host.json`.
Focused lint passed for the host sources/tests, extension contracts, strict journal
and session store, and shared gateway/WS host boundary. All heavy checks used
`D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs`, below-normal
priority and its disk/commit-headroom gates.

Route fallback/move-back and learned-route proofs remain with the route worker;
Auto/picker and screenshot validation remain with shell/coordinator. Independent
security review and final combined verification belong to the coordinator.
Headless hosting and remote updater execution remain deferred as documented in
the parity matrix. These loopback tests do not replace two-machine Tailscale
hardware testing. No full suite, live app/profile/settings/Serve change, push or
PR was performed in this worker.
