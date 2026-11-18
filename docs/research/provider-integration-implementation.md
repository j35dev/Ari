# Optional coding harness integration

Implemented 18 November 2026: Qoder CLI, Meta Muse Code, and DeepSeek Harness are available as optional Ari providers, alongside Pi and Hermes. New or missing preferences enable only Claude, Codex, Grok, and OpenCode. Explicit saved preferences are retained. Ari Core continues to use endpoints the user explicitly configures.

## Using the providers

Open **Settings → Providers**, select the provider, and enable it. Install its CLI using the supplied vendor installer action, or set the executable path to an existing install. The session model picker uses the runtime's own catalog.

| Provider         | Native transport                            | Setup                                                                                                                                                   |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qoder            | `qoder --acp` / native `qodercli.exe --acp` | Existing Qoder login, or `qoder login`. Windows detection includes the native `.qoder` install and avoids the IDE's generic executable.                 |
| Muse Code        | `muse acp`                                  | Native Meta installer and `muse login`. ACP is an upstream experimental feature and may be disabled by organization policy.                             |
| DeepSeek Harness | `dsh --profile acp`                         | npm `@deepseek-ai/dsh`, Node ≥24.9, and credentials for the model provider configured in DSH. ACP session creation does not validate those credentials. |

## Runtime behavior

The integrations reuse Ari's ACP connection, transcript events, approvals, attachments, browser MCP declarations, live catalogs, and session pool. An ACP-only runtime is unavailable when its transport is disabled; no alternate harness is substituted.

DeepSeek's provider-grouped model options retain their exact JSON pair wire IDs. Models with identical names from different providers remain distinct, with provider labels in the picker. An empty native reasoning-default value is represented in Ari as `provider-default` and sent back as the exact empty wire string.

Qoder and Muse permission selectors are mapped using both advertised IDs and labels. Muse's workspace trust is applied only to authorized session launches, not discovery probes. Its Full launch disables the native sandbox; DeepSeek Full uses `DSH_PERMISSION_MODE=danger-full-access`. Limited DeepSeek launches retain `workspace-write` and route approvals through Ari. Id-only permission requests recover their kind and input from the preceding tool announcement.

Object-shaped resume capabilities are supported. Changes to native sandbox launch configuration close the old process before starting its replacement, so a persisted session is not reopened while its previous process owns it.

## Verification evidence

- [Qoder editing/terminal probe](evidence/qoder-acp-feasibility/probe.json): copied a disposable file, executed a terminal command, and answered three one-time approvals through the real ACP adapter.
- [Qoder metadata probe](evidence/native-provider-metadata/qoder.json): installed CLI 1.1.91, eight account-specific models, ACP v1, and same-session resume after process restart.
- [DeepSeek metadata probe](evidence/native-provider-metadata/deepseek.json): published dsh 0.2.2-rc.1, grouped provider/model discovery, four advertised reasoning levels, ACP v1, and same-session resume after process restart. No inference or user-credential changes were performed.
- [Concurrent-load probe](evidence/native-provider-metadata/deepseek-under-concurrent-load.json): retained the initialization timeout observed while the full repository tests overloaded the machine. The subsequent lower-load probe passed.
- Focused tests cover defaults and persistence, optional provider toggles, picker availability, native launches/install plans, grouped models, distinct provider routes, empty default effort round-tripping, tool metadata/approval mapping, object resume capabilities, and old-process release ordering.
- Workspace typecheck and lint passed. The first concurrent full test run hit timing/fork-start failures and an outdated all-enabled migration assertion. The assertion was updated to the requested defaults; the five affected engine suites passed all 92 tests when rerun with one worker.
- The production desktop build passed after the implementation and review fixes.
- Reduced-concurrency full suites passed: UI 337 tests, Ari Core 282 tests, and mobile 374 tests. The two reported desktop failures (Aria navigation and remote change-request refresh) passed all six tests in an isolated rerun. The broader desktop sweep was stopped after these rechecks; it is not recorded as a full-suite pass.

Muse has not been exercised against an installed, authenticated account on this machine. Its native launch and permission behavior are based on the official ACP documentation, with protocol fixtures exercising Ari's handling. Runtime browser MCP connectivity and live Muse inference remain separate verification items.

The research evidence and source URLs are in [Muse/DeepSeek research](muse-deepseek-integration.md) and [Qoder feasibility](qoder-acp-feasibility.md). The metadata-only probe is [probe-native-acp.mjs](../../scripts/research/probe-native-acp.mjs); it creates disposable state under the repository's ignored cache and never sends a model prompt.
