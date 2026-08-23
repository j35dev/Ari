# Provider Drivers Reference

All drivers live in `packages/providers/src/<kind>/` and conform to the
`Driver` interface in `src/driver.ts`. Each has a pure mapper tested against
recorded fixtures in its `__fixtures__/` directory.

| Kind | Binary | Transport | Auth reused from | Fixtures |
|---|---|---|---|---|
| claude | `claude` | **ACP** via `npx @agentclientprotocol/claude-agent-acp`; fallback: `-p --input-format stream-json --output-format stream-json --verbose` + control protocol (stdin steering/interrupt) | `~/.claude/.credentials.json`, `~/.claude.json` | success, error-model-not-found |
| codex | `codex` | **ACP** via `npx @agentclientprotocol/codex-acp`; fallback: `exec --json --skip-git-repo-check` + sandbox/approval flags | `~/.codex/auth.json`, `~/.codex/config.toml` | success, error-quota |
| opencode | `opencode` | **ACP** native (`opencode acp`); fallback: JSON run mode | `%LOCALAPPDATA%/opencode/auth.json`, `~/.local/share/opencode/` | per-driver |
| grok | `grok` | **ACP** native (`grok agent stdio`); fallback: JSON mode | `~/.grok/bin/` install config | per-driver |
| pi | `pi` | **ACP** via `npx pi-acp`; fallback: JSON mode | npm-global install config | per-driver |
| hermes | `hermes` | **ACP** native (`hermes acp`); fallback: JSON mode (synthesized schema) | hermes CLI config | success, error |
| ari-core | *(internal)* | Direct HTTP to user-configured endpoints (openai-chat / anthropic-messages / ollama) | Endpoint keys via safeStorage | client-level |

Since M16 every CLI driver is wrapped in an `AcpDriver`: the Agent Client
Protocol transport is preferred and the legacy one-shot CLI argv driver is
used automatically whenever ACP is disabled (`ARI_ACP=0`) or its handshake
fails. Model catalogs are no longer hardcoded — see `docs/arch-16.md`.

## Adding a driver

1. Create `packages/providers/src/<kind>/mapper.ts` — a total function from
   native lines to normalized `AgentEvent`s. Malformed input yields an error
   event, never a throw.
2. Create `<kind>-driver.ts` with a pure `build<Kind>Args(session)` argv
   builder and a `create()` that spawns via `streamProcessEvents`.
3. Record or synthesize fixtures; write mapper tests covering happy path,
   error path, and malformed-line safety.
4. Export both files from `packages/providers/package.json`; register in
   `apps/desktop/src/main/rpc.ts › buildRegistry`.

## Recording fixtures

Use `scripts/record-fixture.ts`:

```sh
npx tsx scripts/record-fixture.ts --driver codex \
  --prompt "Reply with exactly: hello" \
  --out packages/providers/src/codex/__fixtures__/live-run.jsonl
```

The script spawns the real CLI and captures stdout verbatim. Never commit
secrets captured in fixture output.
