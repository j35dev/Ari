# arch-04 — Provider subsystem

## Detection

`detectDriver(kind, env)` scans PATH + well-known dirs per OS, probes
`--version`, and reads each CLI's credential store read-only to report auth
status. Codex honors `config.toml` provider blocks (custom routers/API keys)
in addition to `auth.json`.

## Control protocol (Claude)

The Claude driver keeps stdin writable for control frames: user-message
steering mid-turn and interrupt requests. Process kill remains a 2s fallback
when the stream doesn't end after an interrupt frame.

## Streaming backpressure

All CLI drivers share `streamProcessEvents`: buffers partial lines, maps
complete lines via the driver's mapper, guarantees exactly one terminal
`done`, surfaces non-zero exits as errors. The async generator pull model
provides natural backpressure — the consumer (engine) processes each event
before pulling the next.
