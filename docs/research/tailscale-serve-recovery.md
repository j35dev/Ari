# Tailscale Serve recovery — workstream A

Branch: `fix/tailscale-serve-recovery`, based on `6f018a75` (main).
Contract-only commit: `cfa56105`; implementation commit recorded in the final report.
Execution: Codex `gpt-6.1-sol`, high effort, full permissions, D: worktree only.

## Behavior and integration contract

The shared fields match `docs/design/machines.md`. `remote.tailscale.enable`
accepts undefined or `{ httpsPort?, replace?: { origin, mountPath: '/', target,
kind: 'proxy' | 'path' | 'text' } }`. Replacement must describe the exact observed
root and defaults to the port in its origin. A second configuration read directly
before the CLI mutation rejects changes at the selected port or ownership record.

Current status always emits the additive, optional shared fields: `httpsPort`,
`target`, `targetListening`, `owned`, `conflicts`, and `suggestedHttpsPort`.
Each conflict includes `origin`, `httpsPort`, `mountPath`, `target`, `kind`, and
`listening`. Listening means a local TCP connection; null means unknown or a
nonlocal/non-proxy target. Probes are limited to 16 distinct loopback targets,
two at a time, with a 500 ms timeout. A dead target never establishes ownership.

Default enable prefers a wholly free 8443 when 443 belongs to another mapping,
including a dead target. Other candidates are 10000 and 10443–10542. Exhaustion
returns actionable choices; callers can explicitly select any valid free HTTPS
port. A saved selected port with a free root is reused alongside surviving
sibling mounts. Changing a still-owned live mount to another port requires
disabling the old root first, so it cannot be orphaned.

The desktop profile has a separate atomic `tailscale-serve.json` record with
version, HTTPS port, exact origin, gateway target, and enabled preference. Editable
settings cannot establish ownership. Matching the current target alone is not
enough; installations without an ownership record preserve legacy mappings and
can choose an alternate port or confirm an exact replacement.

Saved enabled ownership repairs a changed gateway target after startup or gateway
enable, without an interactive prompt. A foreign root at the saved address blocks
automatic restoration instead of silently moving a paired device's address.
Disable verifies and removes only the saved root using `--bg --https=<port>
--set-path=/ off`. It preserves sibling mounts and other ports, and remembers the
port selection while disabling future automatic restoration. Both enable and
disable RPC responses retain their actionable error after refreshing origins.

Unknown/unreadable configurations, corrupt ownership, unsupported foreground or
service configurations, and incompatible HTTP/TCP listeners fail closed. Ari will
not install its gateway on a Funnel-enabled port. Operations are serialized within
the desktop process. Exact non-443 origins feed existing invitation URLs, PWA
hosting and allowed-origin persistence; failed origin writes are retried.

## Sources and read-only machine observation

- [Tailscale CLI Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
  and its [Markdown representation](https://tailscale.com/docs/reference/tailscale-cli/serve.md),
  read in the available browser on 2026-11-11. The page documents alternate HTTPS
  ports, `--set-path`, `--bg`, `--yes`, and path-specific disable with the original
  flags. It lists `reset` as clearing configuration; Ari never calls it.
- Installed CLI: Tailscale 1.102.3. Read-only `version`, `serve --help`,
  `serve status --json`, and `status --json` confirmed the options and JSON shape.
- The observed real mapping was HTTPS 443 to `http://127.0.0.1:3773`; a read-only
  socket inventory found no listener at 3773. No real mapping, settings, paired
  device, or running Ari instance was changed.

## Verification

Main baseline: existing Tailscale/origin suites passed 2 files / 23 tests;
desktop typecheck passed. Focused updated suites use fake CLI runners, injected
listening probes, and D: temporary profiles. Coverage includes dead 443→3773,
live conflicts, exact replacements, replacement races, newly occupied free ports,
mixed proxy/file/text mounts, TCP reservation, ownership restart, stale repair,
missing-root repair, saved-port disable, concurrent operations, corrupted profiles,
unknown configuration and Funnel rejection.

The added pairing test uses a real temporary loopback gateway and PWA fixture
with stub host dependencies. It checks non-443 invitation/PWA/allowed origins,
P-256 pairing with matching confirmation codes, persisted device identity,
gateway restart repair, fresh signed authorization after restart, and rejection
of the unselected 443 origin. The existing QR component consumes that exact
invitation URL; visual QR/PWA installation checks belong to B and hardware.
This is an origin/authentication integration check, not a two-computer or
full-engine end-to-end test.

Final replacement-worker verification on 2026-11-11 (all commands exited 0):

```powershell
pnpm --filter @ari/desktop exec vitest run src/main/tailscale.test.ts src/main/remote-origins.test.ts src/main/tailscale-pairing.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @ari/desktop typecheck
pnpm --filter @ari/contracts typecheck
pnpm exec eslint apps/desktop/src/main
pnpm exec eslint packages/contracts
```

Focused suites passed 3 files / 69 tests. The replacement worker's first run
passed 62 tests before its review fixes. Prettier formatted all eight changed
files; the final formatting check is recorded in the final report.

Each heavy step ran sequentially from a clean committed checkpoint. Its
PowerShell parent used BelowNormal priority, with Node heap capped at 1536 MiB.
TEMP/TMP were `D:/Projects/.ari-cache/tmp` and pnpm store configuration was
`D:/Projects/.ari-cache/pnpm-store`; no install or build was required.
Every step required at least 5 GiB free on C: and at least 1.5 GiB of commit
headroom, measured as commit limit minus committed bytes using
`Win32_PerfFormattedData_PerfOS_Memory`. Pre-step readings
(C: free / commit headroom, GiB):

- Initial focused tests: 16.796 / 2.012.
- Formatting: 16.804 / 2.861.
- Final focused tests: 16.804 / 2.929.
- Desktop typecheck: 16.803 / 2.765.
- Contracts typecheck: 16.804 / 2.507.
- Desktop main lint: 16.803 / 2.966.
- Contracts lint: 16.802 / 4.370.

Self-review tightened two previously ambiguous cases: successful empty CLI
output and Web handlers without a recognizable TCP listener now fail closed.
It also enabled exact confirmation of a valid empty text root without allowing
empty proxy/path targets. Added regression coverage checks replacement-kind
races, incompatible HTTP/TCP selection, and the 16-target/two-probe bound.
No other unresolved code finding remained after scoped validation.

Implementation: `b63c309f`, following contract commit `cfa56105`. The previous
worker rewrote WIP history while the replacement worker was validating; a full
diff from its tested `86c1b33d` checkpoint to `b63c309f` shows only documentation
changes, proving the implementation code tree is identical. After the parent
confirmed the old writer was idle, the replacement worker appended this evidence
without rewriting either retained commit.

## Remaining release checks and limits

Two computers on a tailnet and an iPhone must verify non-443 HTTPS connectivity,
PWA install, pair/reconnect, host sleep/wake, network changes, and ACL denial.
Real CLI path-specific update/disable behavior with mixed mounts also needs a
disposable hardware configuration. UI/screenshots belong to B; A changes no UI.

The CLI does not expose an atomic compare-and-swap for the final mutation. Ari
rechecks immediately before it and verifies other mounts afterward; a separate
process changing Serve in the interval remains an external race. A crash or disk
failure between a successful CLI mutation and the atomic ownership save leaves
an unclaimed mapping; recovery fails closed and requires an alternate port or
exact explicit replacement. No automatic target-based ownership migration occurs.

No user decision is required for the code. Keep the observed foreign 443 mapping
unless the user explicitly confirms its exact replacement in the setup UI.
