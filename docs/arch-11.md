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
replace), glob, grep (JS fallback), todo_write. Every path-touching tool is
jailed via realpath-resolved path checks — symlinks inside the workspace that
point outside are rejected.

## Allowlist enforcement

When an allowlist is configured for the session, bash/write_file/edit_file
check glob-style rules against their candidate strings before executing.
Empty or absent allowlist = allow all (current default).

## Security

- Path jail with symlink resolution (`fs.realpath`)
- Scheme-restricted link rendering in markdown output
- Raw HTML dropped by rehype-sanitize
- API keys encrypted at rest, never logged
- SSRF guardrail: endpoint URLs must be user-configured (no dynamic URL
  construction from tool output)
