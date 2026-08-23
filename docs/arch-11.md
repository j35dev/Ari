# arch-11 — Ari Core harness

## Endpoints

User-configured model endpoints stored in `<userData>/ari-core/endpoints.json`
with API keys encrypted via Electron safeStorage (DPAPI on Windows, Keychain
on macOS, libsecret on Linux). An encrypted-file fallback covers headless
Linux without a keyring. Keys are never logged and redacted in list output.

## Agent loop

`runAgentLoop` streams a model round; when the model requests tools, executes
them (jailed to workspace), feeds results back, repeats until done or round
budget exhausted. All events pass through as normalized `AgentEvent`s.

## Tools

bash (pty, 30s timeout), read_file, write_file, edit_file (exact-match
replace), glob, grep (ripgrep when found on PATH — spawned via the shared
escaped cmd.exe wrapper on Windows — else the JS workspace walk), todo_write. Every path-touching tool is
jailed via realpath-resolved path checks — symlinks inside the workspace that
point outside are rejected.

## Allowlist & permission-mode enforcement

The session's permission mode (`ask` | `allow-edits` | `full`, from
`AdapterSession`) gates Ari Core tools: `full` allows everything,
`allow-edits` allows file edits but not bash, and `ask` gates both bash and
file writes. An absent mode is treated as `ask` (fail-closed). Mode-gated
calls emit an `approval-requested` agent event and park until the host
answers via the adapter's `respondApproval` (or deny when no handler is
configured / the turn aborts). Configured allowlist glob rules intersect
with the mode — a call must pass both, and approvals clear only the mode
gate. Read-only tools (read_file/glob/grep) and todo_write stay available
in every mode; the path jail applies regardless.

## MCP (Model Context Protocol)

`McpServerStore` persists server definitions (`{ id, name, command, args,
env, disabled }`) in `<userData>/ari-core/mcp-servers.json`. At turn start
the driver spawns every enabled server over stdio (newline-delimited
JSON-RPC 2.0; spawned through the shared escaped-cmd.exe wrapper on
Windows with the server env layered over the ambient one), handshakes
`initialize` → `notifications/initialized` within a bounded timeout, and
maps each advertised tool onto the loop's `Tool` shape as
`mcp_<server>_<tool>`. Failures fail soft: a server that dies at spawn,
times out its handshake, or fails tools/list is logged and omitted — the
turn always runs (an unmounted tool call degrades to an errored result).
MCP tools are external side effects, so they gate exactly like bash:
blocked under `ask` and `allow-edits` unless approved per-call or via
always-allow, allowed under `full`; allowlist rules bind by the prefixed
tool name. Arguments pass through verbatim — MCP servers define their own
surface and sandboxing; Ari's path jail applies to its built-in file
tools only. Connections live for one turn and are disposed with the
adapter.

## Security

- Path jail with symlink resolution (`fs.realpath`)
- Scheme-restricted link rendering in markdown output
- Raw HTML dropped by rehype-sanitize
- API keys encrypted at rest, never logged
- SSRF guardrail: endpoint URLs must be user-configured (no dynamic URL
  construction from tool output)
