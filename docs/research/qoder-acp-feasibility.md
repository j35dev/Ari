# Qoder integration feasibility

Investigated on 18 November 2026 against this Ari checkout and the installed Windows x64 Qoder CLI 1.1.91.

## Recommendation

Add Qoder as a native ACP driver in `@ari/providers`, using the existing `AcpDriver`, session pool, event mapper, approval bridge, and live model catalog. This is a focused provider integration. Qoder runs its own coding harness; Ari Core does not need to implement its agent loop.

The vendor documents `qoder --acp`, with JSON-RPC over stdin/stdout. This command was verified against the installed native `qodercli.exe`, even though `--help` does not list the flag. The Zed listing currently describes `qoder acp`; use the vendor command verified here.

## What worked with Ari's existing code

The opt-in [probe script](../../scripts/research/probe-qoder-acp.mjs) bundles and runs Ari's actual ACP code against Qoder. It does not register a production driver or change Ari settings. [Recorded evidence](evidence/qoder-acp-feasibility/probe.json) contains the initialization response, runtime catalogs, normalized tool events, approval options, and turn results.

| Area                    | Observed result                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol                | ACP v1 initialization succeeded; agent identity was `qoder-cli`, version `1.1.91`.                                                                                                                                                                                                       |
| Authentication          | Session creation reused the existing login. Initialization advertised a runnable terminal login, `qodercli login`, already understood by Ari.                                                                                                                                            |
| Models                  | Eight account-specific models exposed through both `models` and `configOptions`; Ari's existing catalog reader consumed the config options.                                                                                                                                              |
| Permission controls     | Qoder advertised `default`, `acceptEdits`, `auto`, `dontAsk`, and `yolo`. Ari applied Ask, Allow edits, and Full during the probe using its existing selector mapping.                                                                                                                   |
| Tools and approvals     | A model prompt read a disposable file, copied it, and executed a Windows terminal command. Three `allow_once` approvals were answered through Ari's adapter. All four tool calls completed without tool errors. The copied bytes matched and the terminal returned `ARI_QODER_PROBE_OK`. |
| File/terminal transport | Only `session/request_permission` came back as a client RPC. Qoder used its own local file and terminal tools when Ari advertised `fs` and `terminal` as unavailable. The documentation's client-hosted tools are not required for this tested configuration.                            |
| Process continuity      | Four turns reused one process through Ari's ACP pool; a fifth turn completed through the adapter's session-load path after restarting the process. The original recording does not retain the native session-ref equality check.                                                         |
| Reasoning catalog       | `efficient` offered no effort selector. Selecting `qmodel_latest` exposed `xhigh`, `high`, `low`, and `none`, which Ari consumed. Explicit effort changes and a reasoning-model inference were not exercised.                                                                            |

The terminal's first `cmd /c type` invocation encountered MSYS argument conversion. Qoder retried with `MSYS2_ARG_CONV_EXCL='*'` and produced the correct output. This is a Windows shell behavior to include in future smoke testing.

## Changes needed for a first integration

1. Add `qoder` to `driverKindSchema` in `packages/contracts/src/common.ts`. Extend the provider settings shape, model fallback, and desktop/mobile provider labels and icon mappings.
2. Extend `packages/providers/src/detector.ts` to find the coding CLI, including `qodercli.exe` and the Windows `qoder.cmd` shim. The local installation uses `~/.qoder/bin/qodercli/qodercli.exe` and `~/.qoder/entry/qoder.cmd`. Detection must distinguish the CLI from the Qoder IDE launcher, which can share the `qoder` name. Use a live auth probe rather than guessing credential filenames.
3. Add `qoder: ['--acp']` to the native launch mapping in `packages/providers/src/acp/launches.ts`.
4. Extend the CLI-kind lists, `acpProbeKinds`, and `hydrateDrivers` in `apps/desktop/src/main/rpc.ts`. Register `new AcpDriver('qoder', launch, null, ...)` and keep the existing browser MCP wiring. Hydration currently requires every candidate to have a legacy CLI factory; make that optional for Qoder. When ACP is disabled or unavailable, report the provider as unavailable rather than describe a nonexistent CLI fallback.
5. Use live catalogs for models, modes, and per-model efforts. The initial current model was `auto`, while the offered list began with `efficient`; preserve the agent's current/default identity rather than assume the first row is the current model.
6. Adjust `sessionResumeSupported` and its protocol type to recognize object-shaped ACP session capabilities. Qoder advertises `sessionCapabilities.resume: {}`, while Ari checks `=== true`. Existing `loadSession: true` provides the working load path. Add focused regression coverage for capability shapes and Qoder's advertised vocabulary.

Install/update UI, configuration-file editing, extra accounts, and a CLI fallback can follow separately. The installed CLI supports `--config-dir` and `update`; account isolation and the vendor's installation channels need verification before exposing those controls.

## Limits and follow-up verification

- Native live steering is not advertised in Ari's `_session/steering` vocabulary. Current behavior is queued follow-up delivery.
- Qoder advertises fork/list/resume/delete/close capabilities as objects. Native fork and child management are not exposed by Ari's generic ACP adapter. The probe intentionally launched no subagents.
- The documentation advertises `/about` and `/help` in ACP, but this installed build replied that both require interactive UI. Those exchanges completed at the protocol level; the slash-command functions were unavailable.
- Image input and HTTP/SSE MCP are advertised. Image prompts, browser MCP calls, question elicitation, cancellation, denied approvals, and restoration of pending approvals were not exercised.
- Live validation was Windows x64 only. The vendor lists macOS/Linux arm64 and amd64, plus Windows amd64; Windows arm64 is currently excluded.
- Verify the completed integration through provider detection/settings, the composer, remote contracts, actual sessions, and focused provider tests. Run the repository-required checks before committing implementation changes.

## Sources

- [Qoder ACP documentation](https://docs.qoder.com/cli/acp)
- [Qoder configuration reference](https://docs.qoder.com/cli/settings-reference)
- [Zed's Qoder ACP listing](https://zed.dev/acp/agent/qoder-cli)
- Ari code: `packages/providers/src/acp/{connection,acp-driver,launches,modes,thought,session-pool}.ts`, `packages/providers/src/{detector,catalogs,account-home}.ts`, `packages/contracts/src/{common,settings}.ts`, and `apps/desktop/src/main/rpc.ts`.
