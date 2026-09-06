# M42 — Header account allowance

Account quotas are separate from Ari's additive session-token/cost totals.
`providers.allowance` reads one detected provider; parallel readers coalesce in
the main process and failures retain the previous sample with an error status.
The header refreshes every 60 seconds, when opened, and on session/provider
changes. Provider errors cannot block successful rows. No credential material
crosses IPC. Missing data is unavailable, never a fabricated zero.

Sources verified against installed CLIs on 2026-09-06:

- Grok: `_x.ai/billing`, the read-only ACP extension behind the terminal `/usage`
  view. Reads `creditUsagePercent` and the typed weekly/monthly `currentPeriod`.
  No terminal scraping or user-session prompt is required.
  [Upstream implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs).
- Codex: native `account/rateLimits/read`. Ari's pinned ACP adapter 1.7.0's
  `/status` does not actively refresh limits; a fresh probe returned no limits.
  The native account request supplies real windows without creating a thread.
- Claude: an advertised `/usage` in a separate ACP session; only recognized
  quota lines are accepted. The installed 0.70.0 adapter/account returned only
  token/cost totals, so it correctly displays unavailable here. Newer formatters
  expose quota lines, with reset text preserved verbatim because locale-formatted
  timestamps should not be guessed.
  [Upstream formatter](https://github.com/agentclientprotocol/claude-agent-acp/blob/main/src/usage-markdown.ts).
- Other providers: unavailable until a verified account-quota reader exists.

Readers do not install adapters, invoke login, or submit ordinary model prompts.
Requests have deadlines and temporary transports shut down after each read.
The UI prefers 5h, then Weekly, then the provider's actual period (including
Monthly); it labels stale samples and expired resets without inventing a reset.

Validation: parser/lifecycle/UI tests plus an opt-in installed-CLI smoke test:
`ARI_LIVE_ALLOWANCE=1 pnpm --filter @ari/desktop exec vitest run src/main/allowance-live.test.ts`.

Visual verification limitation: `pnpm dev` built successfully but the existing
Ari instance held the single-instance lock, so the new process exited. A browser
preview could not be inspected because no browser surface was enabled. UI
behavior is covered by component tests; no screenshot verification is claimed.
