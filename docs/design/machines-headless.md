# Headless Machines host

Status: implementation design. The desktop core, signed routes and one-way
pairing ship first. No command or service described here is implemented yet.

## Runtime and ownership

Add an Electron-independent `@ari/host` executable behind `ari host`. It builds
the existing SessionStore, ProjectStore, Engine, provider registry, control
supervisor, RemoteHost and remote gateway through a shared host bootstrap. The
desktop and headless executable use the same host adapters and wire schemas;
neither exposes the renderer RPC registry to the network. Refactor the current
desktop bootstrap into injected services before adding a second implementation.

The bootstrap receives profile path, secure-storage adapter, provider catalog,
workspace resolver, process runner, resource sampler, update-status reader and
shutdown hooks. It owns no UI, microphone, browser, global shortcut or desktop
tray. Provider authentication happens locally using the provider's existing
login command. Remote clients cannot install providers, read credentials or run
arbitrary configuration commands.

An explicit absolute profile is required for scripted runs. Interactive runs use
the platform's Ari Host data directory, separate from Ari Desktop by default.
A profile lock records PID, process-start identity and runtime ID. Desktop and
headless sharing an explicitly selected profile must acquire the same lock
before reading mutable stores. A live owner is refused. Stale lock recovery
requires verifying that the recorded process instance has ended; a PID alone
does not identify a process across reuse. Corrupt lock or identity data requires
operator recovery, never silent reset. Profile ownership is released only after
listeners, providers, journals and persistence have finished shutting down.

Stable machine ID, sealed signing key and established-key anchor persist across
runtime restarts. Linux Secret Service and macOS Keychain adapters implement the
same SecretBox contract as desktop storage. Windows uses a DPAPI adapter without
Electron. A missing/unavailable keyring refuses credential-dependent hosting;
there is no plaintext fallback. Existing desktop key material cannot be copied
to a new profile or rebound to a new origin. A future explicit profile migration
must decrypt and re-seal locally and preserve both identities and grants.

## Commands and scripts

| Command | Behavior |
| --- | --- |
| `ari host serve --profile PATH --port PORT` | Foreground engine and loopback gateway. Prints readiness after durable stores and listener initialization. Ctrl+C drains and stops only this runtime. |
| `ari host up --profile PATH` | Interactive setup and explicit reachability choice, then foreground serve. Linux/macOS may offer a user service after showing its exact definition; Windows prints the foreground command. |
| `ari host pair --profile PATH --name NAME --json` | Ask the running host's local control channel for a fresh bounded invitation. Return link/code/expiry only when an independently verified exposure exists. No automatic approval. |
| `ari host approve --profile PATH --invitation ID --code CODE` | Host-local confirmation of the requesting device name, exact displayed code and terminal grant. Requires an attached operator; unattended script flags do not approve devices. |
| `ari host devices --profile PATH --json` | Host-local incoming devices and separate terminal grants. |
| `ari host revoke --profile PATH --device ID` | Persist withdrawal before success; close authenticated streams and terminals. Failure latches authorization denial until durable recovery. |
| `ari host status --profile PATH --json` | Distinguish configured, profile owner, listening, ready, verified exposure, protocol/Ari version and update state. Includes no invitation secret or provider token. |
| `ari host project add PATH --profile PATH` | Host-local project registration; remote clients do not create or clone repositories. |
| `ari host service install/uninstall --profile PATH` | Optional user service only on Linux/macOS. Show exact target and command; uninstall preserves profile data and never resets Serve. |

`--json` produces one versioned result object per command; logs go to stderr.
Version 1 envelope is `{ok,result}` or `{ok:false,error:{code,message}}`. Status
includes runtime ID, PID, machine ID, profile owner, listener port, ready state,
verified route origins, Ari/protocol version and safe recovery reason. Exit 0
means completed; 2 invalid input, 3 profile busy, 4 secure storage unavailable,
5 host unavailable, 6 confirmation required, 7 persistence/recovery failure and
8 unknown outcome. Commands never infer success from a reconnect. Long-running
serve emits readiness once and does not report successful startup before it.

The local management channel is a Unix socket inside a private profile directory
or a Windows named pipe restricted to the current user. Authenticate the profile
owner and runtime ID; cap frames and timeouts. It is never bound to a TCP port,
exported through the gateway or reused as a cross-machine control socket. Device
approval remains an operator decision. Agent control grants do not grant host
management or permission to follow a saved peer connection.

## Reachability and pairing

Foreground serve binds loopback. Tailscale setup is an explicit local operation
using the existing Serve recovery/ownership rules: alternate HTTPS port or exact
confirmed replacement, preserve foreign mappings, and remove only owned mounts
on disable. Status probes are read-only. No Funnel, LAN discovery, relay or SSH
transport is introduced. LAN remains a future setting off by default.

The verified served origin supplies route authority. Never derive it from
allowedOrigins, request Host, Origin, forwarded headers or client claims. A
listener with ambiguous ingress cannot authorize route reuse. Signed manifests,
fresh candidate nonce proofs and audience-bound challenges reuse the desktop
route protocol. Bearers stay route-specific and HTTPS credentials never downgrade
to HTTP. Restart preserves independently paired credential slots and pinned keys.

Pairing is one direction: the requesting desktop may use this host only after
this host approves it. Reverse access requires a new invitation and approval on
the other host. No group membership, transit, implicit Aria access or worker
access follows from pairing. Direct paired devices get all current and future
projects, with terminal access an explicit separate host-local grant. Managed
Connect retains its existing signed project intersection and lease expiry.

## Services and updates

Linux uses a user systemd unit; macOS uses a user LaunchAgent. Service definitions
contain only the absolute executable/profile arguments, never invitation keys
or provider credentials. They use private log directories and a bounded restart
backoff. Windows v1 provides the foreground command and no scheduled task or
Windows service installer. Service readiness means listener and stores are ready;
it does not assert tailnet or provider reachability. Stop cancels startup races,
stops descendant provider trees, closes grants/streams and flushes journals.

Remote update execution needs a separate launcher-owned transaction. Prepare
validates a named official release/channel and package signature, stages outside
the active binary, and records an update ID durably. Commit requires explicit
operator approval of host name, version and interruption counts. The launcher
stops the old runtime, takes a recoverable profile backup, trials migrations and
readiness, then commits or rolls back. Querying the same update ID is read-only;
unknown commit is never resent. Readiness must correlate update ID, expected
binary version and profile migration version. Reconnect alone cannot prove it.
Until this exists, authorized host.version supplies accurate manual update
guidance. There is no generic remote shell updater or automatic session resume.

## Implementation sequence and acceptance

1. Extract shared host bootstrap and process shutdown with identical desktop
   behavior. Add OS secure-storage adapters and cross-runtime profile locking.
2. Implement foreground/status and host-local project management with bounded
   JSON output and injected test profiles. Add local approval/devices/revoke.
3. Reuse Serve recovery and signed routes, then user-service adapters. Package
   the host executable and document provider login and platform prerequisites.
4. Add launcher transaction only after foreground/service lifecycle is proven.

Required tests: two real engines/gateways, desktop-to-headless first-send and
restart ownership; no reverse or transitive authorization; revoked device loses
streams/terminal access; failed grant saves/identity restore fail closed; local
pipe permissions and foreign runtime refusal; canceled startup cannot publish a
listener; bounded journal replay and receipt-loss status checks; exact workspace
cleanup; resource sampling on demand; verified route fallback/move-back and
no downgrade; scripted JSON/exit codes; platform service install/uninstall in
disposable accounts; updater trial failure, rollback, crash at each durable
boundary and unknown-commit reconciliation. A fresh independent security review
must cover the executable and management channel before release.

Outstanding now: all four implementation steps and their platform packaging,
runtime/security proofs. This design creates no headless listener or service.
