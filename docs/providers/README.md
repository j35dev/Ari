# Provider drivers

One page per external CLI driver Ari spawns. Facts below are pulled from the
driver sources in `packages/providers/src/*` (argv builders, mappers, detector)
— treat this file as the human-readable mirror of that code.

Common spawn conventions for every driver:

- Binary resolved by `findBinary()` across `PATH` plus well-known dirs
  (`%LOCALAPPDATA%\Programs` and its `npm` subdir on Windows; `~/.local/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin` elsewhere). Windows also
  matches `.cmd` / `.exe` suffixes.
- Spawned with `cwd = session.workspacePath`, `stdin = ignore`,
  `windowsHide = true`. stdout is parsed as JSONL; stderr is logged as debug
  noise, never parsed.
- Permission modes map per driver (see each page) — `ask` / `allow-edits` /
  `full` are Ari's modes from `@ari/contracts`.
- Fixtures are recorded once from real CLIs and replayed in unit tests:

  ```
  npx tsx scripts/record-fixture.ts --driver <name> --prompt "..." \
    --out packages/providers/src/<name>/__fixtures__/<file>.jsonl [--force]
  ```

---

## claude

Source: `src/claude/claude-driver.ts`, `src/claude/mapper.ts`.

| Field | Value |
| --- | --- |
| Binary | `claude` (`claude.cmd` / `claude.exe`) |
| Transport | one-shot print mode (`-p`), stream-json on stdout only; control protocol (approvals, steering, resume RPC) is M4.7 |
| Key argv flags | `-p <prompt>`, `--output-format stream-json`, `--verbose` (always), `--model <id>`*, `--resume <id>`*, `--permission-mode default\|acceptEdits\|bypassPermissions` |
| Auth file | `~/.claude/.credentials.json`, legacy `~/.claude.json` (macOS keychain not probed — status falls back to `unknown`) |
| Fixtures | `src/claude/__fixtures__/success-session.jsonl`, `error-model-not-found.jsonl` |

\* optional, only when set on the session.

Known quirks:

- `--verbose` is required alongside `stream-json` in print mode or the CLI
  refuses to stream.
- Tool results arrive on `user`-typed lines (`tool_result` blocks), not
  assistant lines; tool calls start from assistant `tool_use` blocks.
- Usage + `total_cost_usd` ride the final `result` line. Errors surface either
  as a top-level `error` string or as `result.is_error = true`.
- `system` init lines carry session metadata but nothing transcript-worthy.

## codex

Source: `src/codex/codex-driver.ts`, `src/codex/mapper.ts`.

| Field | Value |
| --- | --- |
| Binary | `codex` |
| Transport | `exec --json` one-shot JSONL events; prompt passed as trailing positional. `app-server` JSON-RPC reserved for rich control; `AdapterSession.resumeOf` is accepted but not yet mapped onto the exec argv |
| Key argv flags | `exec --json --skip-git-repo-check`, `--model <id>`*, sandbox/approval mapping below |
| Auth file | `~/.codex/auth.json` (missing ⇒ reported unauthenticated) |
| Fixtures | `src/codex/__fixtures__/success-session.jsonl`, `error-quota.jsonl` |

Permission-mode mapping (Ari → codex policy flags):

| Ari mode | codex flags |
| --- | --- |
| `ask` | `--ask-for-approval on-request` |
| `allow-edits` | `--sandbox workspace-write --ask-for-approval on-failure` |
| `full` | `--sandbox danger-full-access --ask-for-approval never` |

Known quirks:

- `item.completed` may arrive without a preceding `item.started`; the mapper
  synthesizes the started event so tool cards stay consistent.
- Error lines starting with `Reconnecting...` are transport noise and dropped.
- Usage appears only on `turn.completed` — `turn.failed` yields none, and cost
  is never emitted (`costUsd: null`). Non-zero `exit_code` marks a failed tool.
- `--skip-git-repo-check` is always passed so fixtures can be recorded outside
  repos.

## opencode

Source: `src/opencode/opencode-driver.ts`, `src/opencode/mapper.ts`.

| Field | Value |
| --- | --- |
| Binary | `opencode` |
| Transport | `run --format json --thinking` part-stream JSONL (serve API alternative noted in PLAN §4.1) |
| Key argv flags | `run --format json --thinking`, `--model <id>`*, `--session <id>`* (resume), `--auto` **only** when mode is `full` |
| Auth file | Windows: `%LOCALAPPDATA%\opencode\auth.json`; else `~/.local/share/opencode/auth.json` or `~/.config/opencode/auth.json` |
| Fixtures | `src/opencode/__fixtures__/live-run.jsonl` (real run incl. tools), `error-server.jsonl` |

Known quirks:

- No per-mode permission flags exist: `ask`/`allow-edits` run at the CLI's
  default ask behavior; only `full` escalates via global `--auto`.
- Plain-text log chatter interleaves with JSON; non-`{`-prefixed lines are
  ignored rather than treated as parse errors.
- `step_finish` with reason `tool-calls` is not terminal — more steps follow;
  usage is emitted per step, terminal only on other reasons.
- Bash exit code hides in `state.metadata.exit` and drives `isError` together
  with `state.status === 'error'`.

## grok

Source: `src/grok/grok-driver.ts`, `src/grok/mapper.ts`.

| Field | Value |
| --- | --- |
| Binary | `grok` |
| Transport | `-p` streaming Messages NDJSON (Anthropic wire format) |
| Key argv flags | `-p <prompt>`, `--output-format streaming-messages-json`, `--include-partial-messages`, `--model <id>`*, `--resume <id>`*, `--permission-mode default\|acceptEdits\|bypassPermissions` |
| Auth file | layout not yet confirmed — auth status reports `unknown` |
| Fixtures | `src/grok/__fixtures__/success-session.jsonl`, `error-quota.jsonl` (recorded from grok CLI 1.0.5) |

Known quirks:

- The driver always passes `--include-partial-messages`: text/thinking arrive
  as `stream_event` deltas while whole-message blocks are skipped to avoid
  duplicates. `tool_use` is still mapped from the finalized assistant message
  where its input JSON is complete.
- Failed results detected via `is_error` or `subtype` starting with `error`;
  messages come from the `errors[]` string array (fallback: generic message).
- Init-line tool/skill listings were trimmed when recording fixtures.
- Usage + `total_cost_usd` arrive on the final `result` line.

## pi

Source: `src/pi/pi-driver.ts`, `src/pi/mapper.ts`.

| Field | Value |
| --- | --- |
| Binary | `pi` |
| Transport | print mode `--mode json --no-session`, prompt via `-p` |
| Key argv flags | `--mode json --no-session`, capability gating (below), `--model <id>`*, `--session <id>`* (resume), `-p <prompt>` |
| Auth file | layout not yet confirmed — auth status reports `unknown` |
| Fixtures | `src/pi/__fixtures__/success-session.jsonl` (synthesized), `error-auth.jsonl`, `error-provider-credits.jsonl` (real runs, pi 0.84.x) |

Permission-mode mapping (no approval channel exists, so Ari modes map onto
tool capabilities):

| Ari mode | pi flags |
| --- | --- |
| `ask` | `--tools read,grep,find,ls` (read-only) |
| `allow-edits` | `--exclude-tools bash` (everything except shell) |
| `full` | *(none — all tools)* |

Known quirks:

- Streaming `message_update` deltas are ignored; complete blocks map once at
  `message_end`, mirroring the item-level approach of claude/codex mappers.
- `turn_end` carries `toolResults` duplicating `tool_execution_end` — skipped
  to avoid double emission.
- Assistant failure surfaces as `stopReason: 'error'` plus `errorMessage`
  inside `message_end`, not as a dedicated error event type.
- Usage is read from the last assistant message at `agent_end`
  (`usage.input`, `usage.output`, `usage.cost.total`).

## hermes

Source: `src/hermes/hermes-driver.ts`, `src/hermes/mapper.ts`.

| Field | Value |
| --- | --- |
| Binary | `hermes` |
| Transport | `-p --output-format stream-json --verbose` (mirrors claude) — **unverified** |
| Key argv flags | same shape as claude: `-p <prompt>`, `--output-format stream-json`, `--verbose`, `--model <id>`*, `--resume <id>`*, `--permission-mode default\|acceptEdits\|bypassPermissions` |
| Auth file | not yet confirmed |
| Fixtures | `src/hermes/__fixtures__/success-session.jsonl`, `error-session.jsonl` — hand-written against the documented schema |

Known quirks:

- The hermes CLI was unavailable locally when the driver landed: every flag,
  wire shape and fixture is synthesized after Claude Code's stream-json format.
- Probe flags against the real binary first and re-record all fixtures via
  `scripts/record-fixture.ts` before trusting mapper behavior.
