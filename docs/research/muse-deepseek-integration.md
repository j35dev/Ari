# Meta Muse Code and official DeepSeek Harness integration research

Investigated 18 November 2026. Scope was read-only research plus this evidence document; no production source edits, global installs, inference calls, or agent work launched through either harness. Official sites were inspected in Ari's in-app browser. Published npm packages were downloaded with `npm pack --ignore-scripts` into a temporary directory; no dependency or install scripts ran. The official Muse SDK repository and its published documentation branch were inspected locally because the browser text snapshot truncates long pages.

## Minimum integration

| Ari driver key | Distribution and executable                                             | Machine launch      | Recommendation                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `muse`         | Native vendor installer; `muse` on Unix, `muse.cmd` launcher on Windows | `muse acp`          | Existing ACP adapter with live model/mode/effort discovery. Opt-in integration; upstream ACP is experimental. No fabricated one-shot fallback.                       |
| `deepseek`     | npm `@deepseek-ai/dsh`; executable `dsh` (`lib/bin.js`)                 | `dsh --profile acp` | Existing ACP adapter with grouped option support, object-shaped resume support, and session-specific permission launch environment. No fabricated one-shot fallback. |

Both speak ACP v1 as newline-delimited JSON-RPC over stdin/stdout, own their filesystem and terminal tools, and can run with Ari advertising client filesystem and terminal capabilities as false. Both also offer separate native SDK protocols, but those are unnecessary for the first ACP integration.

## Muse distribution, launch, and authentication

Official installation commands:

```sh
# macOS / Linux
curl -fsSL https://dev.meta.ai/install.sh | bash
```

```powershell
# Windows
irm https://dev.meta.ai/install.ps1 | iex
```

The Unix installer defaults to `$HOME/.local/bin/muse`; `MUSE_INSTALL_DIR` overrides it. The Windows installer requires PowerShell 5.1 or newer and defaults to `%LOCALAPPDATA%\Programs\muse`, also overridable by `MUSE_INSTALL_DIR`. It writes `muse.cmd` and `.muse-launcher.ps1`; the shim invokes Windows PowerShell with `-NoProfile -ExecutionPolicy Bypass -File`. Detection and spawning must handle the `.cmd` shim. The launcher obtains the native runtime. The native binary itself is not supplied by the TypeScript SDK npm package. macOS, Linux, and Windows are explicitly supported; CPU architecture coverage was not independently established. The Windows sandbox can trigger first-time UAC initialization; ordinary use is not administrator-only.

`muse acp` is enabled by default in the documented 1.4 release. `muse acp --help` is a non-inference availability check. `MUSE_EXPERIMENTAL_ACP` closes the gate unless its value is case-insensitive `on`, `true`, or `1`; remote configuration can also close it, and `MUSE_EXPERIMENTAL_SDK_ENABLED=off` closes ACP/serve/schema. Organization policy can disable it. Gate refusal exits 5; malformed ACP launch arguments exit 2; configuration/profile/credential loading failures can exit 3. Do not override an organization's gate or silently switch to another transport.

Useful documented ACP arguments are `--model <MODEL>`, `--trust-workspace`, `--no-session-log`, `--disable-request-user-input`, and `-c <KEY=VALUE>`. `--trust-workspace` is necessary to load project rules and skills. The normal Ari session launch can include it for an authorized workspace; discovery probes should avoid it. Do not use `--no-session-log` for ordinary sessions because it disables list/load/resume. Approval flags such as `--yolo` and `--approval-mode`, `-c` keys under `permissions`, socket daemon flags, and extra positional words are rejected. Modes are selected over ACP.

ACP supports Muse Code login only; other providers and their API keys are unsupported in this transport. `muse login` starts device-code browser sign-in, `muse logout` signs out, and ACP reuses that stored login. An unauthenticated session fails with `log in to Muse before opening a session`. ACP offers `Log in to Muse`; a client supporting URL elicitation receives a login link. A client without that support receives an error containing the link and code while login continues in the background. Ari should offer the verified terminal login command rather than assume a credential filename. The general CLI/headless documentation also mentions `META_API_KEY`; that is not evidence that ACP accepts arbitrary API-key profiles.

The installer is an idempotent installation workflow. A distinct Muse update subcommand was not verified; do not invent one. Re-running the vendor installer is available, but exact pinned-version installer support was not established.

## Muse models, modes, continuity, and MCP

The ACP docs confirm runtime Model and Reasoning effort selectors. If the model catalog cannot be loaded, only one model may appear; `/compact` can also be unavailable without a live or cached catalog. Do not infer catalog availability from the marketing model table. The general overview's initial model is `muse-spark-1.2`; account-specific current/default identity should come from the actual session.

The four documented approval labels are:

| Label                        | Behavior                                         |
| ---------------------------- | ------------------------------------------------ |
| Allow all                    | Every action runs without an approval request.   |
| Ask before unmatched actions | Ask when no permission rule covers an action.    |
| Ask on request               | Ask only when the action requires it.            |
| Deny unmatched actions       | Refuse actions not covered by a permission rule. |

The official MSP schema's `ApprovalMode` IDs are `allowAll`, `promptUnmatched`, `onRequest`, and `denyUnmatched`. The corresponding ACP IDs and exact `configOptions` layout were not directly observed: the public ACP guide gives labels, and the public repository contains MSP source, not Muse's native ACP translator source. Verify those values in a keyless/live control handshake before hardcoding an ACP mapping. Generic regex handling of `allowAll`/`promptUnmatched` will need attention if those IDs appear on ACP. Read-only and plan modes are explicitly unsupported in Muse ACP today.

Approval mode and sandbox posture are separate. ACP accepts the serve sandbox options; `--disable-sandbox`, `--sandbox-network <MODE>`, `--disable-write`, and `--disable-shell` establish the host ceiling at spawn, and protocol mode changes cannot expand it. `allowAll` alone is not evidence of unrestricted filesystem/network execution. A full-permission Ari launch needs a conscious spawn-time choice; restrictive launches must retain their ceiling. The host refuses shell execution when an enabled sandbox cannot be enforced.

Muse supports session list, load with transcript replay, and resume while logging is enabled. A session cannot simultaneously be open in another Muse process. ACP close/delete is not supported. A running prompt queues later prompts; cancellation stops the running turn and already queued prompts. `/compact`, skills, plan/usage/title updates, streamed replies/thoughts, and edit diffs are documented. Some interactive questions use forms; unsupported elicitation cancels the question and the turn continues.

Session MCP declarations support stdio and HTTP, not SSE. A failing editor MCP server does not prevent session creation, so a successful `session/new` is not proof that Ari browser MCP connected. `MUSE_ENABLE_SESSION_MCP` can disable session-supplied servers; settings-configured servers can still start. Preserve diagnostics for this case and verify MCP separately. The agent does not use client filesystem/terminal APIs or unsaved editor buffers.

The stable alternative is MSP: `muse serve`, with `muse schema` printing the schema bundle. npm `@muse-code/sdk@1.4.23` requires Node >=20, has zero runtime dependencies, and has no CLI bin. Python package is `muse-code-sdk`; the repository also contains a Rust SDK. MSP includes initialization, session start/resume, model listing, approval responses, event folding, cancellation, durability, and fingerprint conformance. It should be a separate future transport, not an opaque ACP fallback.

## DeepSeek distribution and launch

Verified npm metadata for `@deepseek-ai/dsh@0.2.2-rc.1`: `bin.dsh = lib/bin.js`, Node engine `>=24.9.0`, repository directory `apps/cli`. npm's current latest tag was rc.1 while GitHub master had already advanced to rc.4; pin the inspected version for reproducible probes and do not assume master matches a user's release. The official CLI has no separate public ACP or SDK binary.

`dsh <profile>` abbreviates `dsh --profile <profile>`. Use explicit `['--profile', 'acp']` for Ari. The ACP app's inner command provider accepts zero options; model, effort, and session choices are protocol operations. The launcher also supports repeatable `--patch <path>` and config dump modes. The shipped ACP profile auto-initializes under `$DSH_HOME/profiles/acp` on first use. Profile/home/per-launch patches are trusted composition and may change transport behavior; arbitrary user plugins can contaminate stdout. The shipped profile reserves stdout for ACP, disables HMR, and shuts down on EOF, disconnect, SIGINT, or SIGTERM.

An install path is `npm install -g @deepseek-ai/dsh` when the user chooses installation and Node >=24.9.0 is present; `npx @deepseek-ai/dsh web` is the upstream quick-start distribution path. These commands were not executed. No npm OS/CPU restriction appeared in the metadata. The base profile explicitly supports Windows with native ACL/restricted-token sandbox and PowerShell tools, and macOS/Linux with Bash tools. Desktop/runtime distributions are separate; do not identify the Electron UI executable as the `dsh` automation launcher.

## DeepSeek exact ACP contract

The published `@deepseek-ai/dsh-acp` implementation initializes with:

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "deepseek-harness-acp", "version": "0.0.1" },
  "agentCapabilities": {
    "mcpCapabilities": { "http": true },
    "promptCapabilities": { "image": "route-dependent", "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
  },
  "authMethods": []
}
```

The displayed `image` string above denotes the actual route-dependent boolean. This is a source contract, not a captured runtime handshake. The agent-info version does not match npm package version; do not use it as the installed distribution version.

Supported methods: `initialize`, `authenticate`, `session/new`, `session/list`, `session/resume`, `session/close`, `session/set_config_option`, `session/prompt`, `session/cancel`, and `$/cancel_request`. No `session/load`, deletion, fork, legacy model setter, modes, slash commands, plan UI, ACP terminals, client filesystem, additional directories, or elicitation. Initialization `authenticate` is an immediate success with no transport authentication; it does not validate model credentials. Ari must report unknown authentication rather than claim verified model login. Base credentials come from managed `$DSH_HOME/.credentials.yaml`, then inherited environment, project `.env`, and user `.env`; the Web UI provides Settings > Models to configure a DeepSeek API key. Exact credential variable/key routing was not independently inspected.

Sessions use absolute `cwd`. New session publishes only after workspace/MCP validation and configuration discovery. Resume requires the same canonical physical workspace, restores a persisted inactive root session, reinstalls request-supplied MCP, and does not replay old updates. Object-shaped resume capability must be recognized; DeepSeek has no load fallback. Close drains root and descendant work, persistence, and updates, but keeps persisted history for a later resume. List excludes active sessions and subagent-origin records, paginates newest-first, and supports optional absolute cwd filtering.

## DeepSeek live model and effort options

The ACP app default is provider `deepseek-official`, model `deepseek-v4-flash`. The selector's wire value is opaque:

```ts
JSON.stringify([provider, model])
// '["deepseek-official","deepseek-v4-flash"]'
```

`configOptions` is the real live API, not a legacy models fallback. The model row has id/category `model`, type `select`, and nested provider groups:

```ts
{
  id: 'model', category: 'model', type: 'select',
  currentValue: '["deepseek-official","deepseek-v4-flash"]',
  options: [
    { group: 'deepseek-official', name: '...', options: [ { value: '...', name: '...' } ] }
  ]
}
```

Ari's existing flat option type must represent/flatten groups while preserving leaf values. The reasoning row is id `reasoning_effort`, category `thought_level`, type `select`; its flat values come from exact-model metadata. When no explicit provider default effort exists, an empty string denotes `Provider default`. Treat that as a valid current/default selection; do not invent an effort list. Model mutations return the complete configuration state and may change effort options. Configuration/topology updates emit `config_option_update`. Recorded model/effort selection survives resume.

## DeepSeek permissions, tools, and MCP

DeepSeek has no ACP permission-mode selector. The base profile reads `DSH_PERMISSION_MODE` at launch:

| Environment value           | Sandbox / approval     |
| --------------------------- | ---------------------- |
| `read-only`                 | Read-only / ask        |
| `workspace-write` (default) | Workspace writes / ask |
| `danger-full-access`        | Unrestricted / never   |

Use session-specific launch environments and distinct pool keys when Ari changes permission ceiling. `ask` and `allow-edits` can retain workspace-write and bridge approvals; Full requires danger-full-access if it promises unrestricted execution. Merely auto-answering approvals does not remove sandbox restrictions. ACP permission requests contain the toolCallId and choices `allow-once` (`allow_once`) and `reject-once` (`reject_once`), often without title/input in the request itself: classify using previously received tool metadata. Do not silently equate the absence of modes with unsupported approvals.

The agent owns local filesystem and shell tools; Windows mounts PowerShell and disables Bash. `session/update` emits committed assistant text/thoughts, generic tool lifecycle, complete configuration changes, and context usage. Raw provider deltas/retries and DSH presentation data are intentionally omitted. A prompt settles only after its owned root and descendant activity and ordered updates finish.

MCP accepts standard stdio and HTTP declarations. Stdio command must be an absolute executable path; HTTP URL must be absolute http(s), with validated name/env/header fields. Duplicate normalized server names fail. Initial MCP connection/discovery failure rolls back the unpublished session, unlike Muse. SSE and ACP-transport MCP are unsupported. Ari browser MCP should use its HTTP declaration; no client-hosted fs or terminal capability is required. MCP elicitation is not surfaced in this ACP contract.

The separate SDK profile is `dsh --profile sdk`, JSON-RPC stdio, with `sdk-minimal` for a standalone reduced agent composition; headless is `dsh --profile headless "job"`. These are real alternate products but were not needed for the chosen adapter.

## Required verification before claiming completion

- Keyless initialize/new/config probe against the installed distribution; distinguish model credential/catalog failures from transport auth success.
- Muse exact ACP model/effort option IDs and approval mode IDs; map vocabulary from observed values.
- DeepSeek grouped model discovery, empty default reasoning selection, restart/resume, and immutable pool permission ceiling.
- HTTP browser MCP readiness (Muse may open a session despite MCP failure); approvals and tool metadata; Windows `.cmd` launch handling.
- A later user-authorized inference smoke test for real editing/shell behavior. None was run in this research.

## Sources and inspection evidence

Muse primary sources:

- https://dev.meta.ai/products/muse-code
- https://dev.meta.ai/docs/muse-code
- https://dev.meta.ai/install.ps1
- https://dev.meta.ai/install.sh
- https://meta-models.github.io/muse-code-sdk/1.4/guides/editors-acp/
- https://meta-models.github.io/muse-code-sdk/1.4/guides/host-operations/
- https://meta-models.github.io/muse-code-sdk/1.4/guides/quickstart/
- https://github.com/meta-models/muse-code-sdk
- https://github.com/meta-models/muse-code-sdk/blob/main/schema/msp/msp.d.ts (`ApprovalMode`)
- https://github.com/meta-models/muse-code-sdk/blob/main/clients/sdk-ts/package.json
- https://registry.npmjs.org/@muse-code/sdk/-/sdk-1.4.23.tgz

DeepSeek primary sources (read published rc.1 package alongside master docs; do not conflate versions):

- https://www.deepseek.com/en/harness/
- https://github.com/deepseek-ai/deepseek-harness
- https://deepseek-harness.github.io/deepseek-harness/en/guide/quickstart
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/args.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundles/acp-app/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundles/acp-app/cordis.patch.yml
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/index.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/model-control.ts
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundles/base/cordis.patch.yml
- https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-rc.1.tgz

Temporary inspection root: `C:/Users/user/AppData/Local/Temp/ari-muse-deepseek-research`. Packed CLI in `dsh/package`, ACP app in `dsh-acp/package`, bridge implementation in `dsh-bridge/package/lib/index.js`, base composition in `dsh-base/package/cordis.patch.yml`, Muse SDK in `muse-sdk/package`, SDK git mirror in `muse-source`. Dependencies are not installed, so the packed dsh CLI alone is not a runnable handshake environment. npm SDK version was 1.4.23; documentation branch commit was `9552f57c8676dee890e1e012ee5f75230e74b4aa`; its 1.4 page reports upstream commit `a2b76786a596479b07d877f8d20e992f5e45f97d` and schema fingerprint `sha256:6b10316bb7da4b152ae90d076720323576cee999c60b44a55442a6c7bf45195d`.

Quick Qoder installation follow-up requested by parent (existing Qoder feasibility artifact was not edited): https://docs.qoder.com/cli/installation documents native Unix `curl -fsSL https://qoder.com/install | bash`, Windows `irm https://qoder.com/install.ps1 | iex`, built-in `qoder update`, Unix installer upgrade with `bash -s -- --force`, and legacy npm `@qoder-ai/qodercli` on Node >=20. Native install is preferred by the vendor. macOS/Linux arm64 and amd64 are supported; Windows arm64 is excluded. Verified npm 1.1.91 bins: `qoder` points to `bundle/qoder-npm-dispatcher.cjs`; `qodercli` points to `bundle/qodercli.js`.
