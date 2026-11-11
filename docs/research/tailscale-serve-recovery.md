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
gateway restart repair, and rejection of the unselected 443 origin. It is an
origin integration check, not a two-computer or full-engine end-to-end test.
Updated focused verification passed 3 files / 62 tests, with one Vitest worker.
Desktop and contracts package typechecks passed. Scoped ESLint passed for all
changed TypeScript files. Prettier's API confirmed exact formatted content for
the three new/reworked Tailscale files; the CLI formatting check passed the other
changed files. Heavy commands ran individually at below-normal priority, after
saving WIP commits and checking C: free space and virtual commit headroom.
The implementation commit is recorded in the final report.

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
