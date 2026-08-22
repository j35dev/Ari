# Provider Drivers Reference

All drivers live in `packages/providers/src/<kind>/` and conform to the
`Driver` interface in `src/driver.ts`. Each has a pure mapper tested against
recorded fixtures in its `__fixtures__/` directory.

| Kind | Binary | Transport | Auth reused from | Fixtures |
|---|---|---|---|---|
| claude | `claude` | `-p --input-format stream-json --output-format stream-json --verbose` + control protocol (stdin steering/interrupt) | `~/.claude/.credentials.json`, `~/.claude.json` | success, error-model-not-found |
| codex | `codex` | `exec --json --skip-git-repo-check` + sandbox/approval flags | `~/.codex/auth.json`, `~/.codex/config.toml` | success, error-quota |
| opencode | `opencode` | JSON run mode (probed at build time) | `%LOCALAPPDATA%/opencode/auth.json`, `~/.local/share/opencode/` | per-driver |
| grok | `grok` | JSON mode (probed at build time) | `~/.grok/bin/` install config | per-driver |
| pi | `pi` | JSON mode (probed at build time) | npm-global install config | per-driver |
| hermes | `hermes` | JSON mode (synthesized schema; CLI absent at build time) | hermes CLI config | success, error |
| ari-core | *(internal)* | Direct HTTP to user-configured endpoints (openai-chat / anthropic-messages / ollama) | Endpoint keys via safeStorage | client-level |

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
