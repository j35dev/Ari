# M16 — Provider system rework

## Why

The M4 design hardcoded the world it could not yet observe: model lists were static
(`catalogs.ts`), nothing knew whether an installed CLI was stale, and approval decisions
were journaled but never routed back into the live adapter — providers hung forever on
permission prompts. Meanwhile the ecosystem standardized on ACP (Agent Client Protocol):
every one of our six CLIs can now be driven as a JSON-RPC subprocess that *itself*
advertises its models, modes, and permission options.

## What changed

### 1. Update-aware detection (`providers/updates.ts`)

`detectDriver` stays offline and fast. A separate `createUpdateChecker` enriches
detections with `latestVersion` (npm `latest` dist-tag) and `updateAvailable`
(semver compare against the parsed installed version). Kinds not distributed via npm
(grok installer, hermes pip) have no entry — their channel is unknown by design.
Answers are TTL-cached (1h) with a short negative cache so offline boots never storm.
Desktop publishes enriched rounds on the `providers.updates` stream.

### 2. Live model catalogs (`catalogs.ts`, `catalog-service.ts`)

Priority chain behind the synchronous `modelsFor(kind)`:

1. **live** — ACP session config options (`category: "model"`) probed from the agent
   itself (e.g. `opencode acp` reports every model its user actually has credentials for).
2. **cache** — models.dev registry refresh (`api.json`), TTL 6h, disk-cached under
   `<userData>/model-catalog.json`, survives restarts offline.
3. **snapshot** — committed `catalog-snapshot.json`, regenerated via
   `npx tsx scripts/update-model-snapshot.ts`. Renderer-safe pure JSON.
4. **static** — `CLI default` last resort; `ari-core` remains endpoint-driven.

The renderer consumes this through the `providers.models` RPC; `modelsFor` keeps working
for any caller that needs a synchronous answer.

### 3. ACP transport (`providers/acp/`)

- `protocol.ts` — flat defensive wire types plus `AcpUpdateFolder`, which folds
  `session/update` notifications into normalized AgentEvents (deduped tool-call
  lifecycles, usage/cost updates, stop-reason mapping). Unknown update kinds are no-ops.
- `connection.ts` — newline-delimited JSON-RPC 2.0 over stdio: initialize handshake
  (45s ceiling for first-run npx downloads), request/response multiplexing with timeouts,
  server→client routing (`session/request_permission` bridged to a handler; unadvertised
  fs/terminal/elicitation answered `-32601`). Async spawn errors are contained.
- `launches.ts` — per-kind launch table: npx adapters for claude
  (`@agentclientprotocol/claude-agent-acp`), codex (`@agentclientprotocol/codex-acp`),
  pi (`pi-acp`); native servers for opencode (`opencode acp`), hermes (`hermes acp`),
  grok (`grok agent stdio`). Disable with `ARI_ACP=0`.
- `acp-driver.ts` — `AcpDriver.create` connects, opens the session bound to the
  workspace, applies model + permission-mode via session config options (heuristic mode
  matching; unmatched agents keep their default), then sends the prompt on first pull.
  Permission requests become `approval-requested` events; `respondApproval` maps
  allow/deny onto the agent's offered option kinds. **Any ACP failure falls back to the
  legacy one-shot CLI driver** for that turn, logged as a diagnostic.

### 4. Approval decisions reach adapters (`engine.ts`)

`ProviderAdapter` gained optional `respondApproval(approvalId, decision)`. The engine's
active-turn record forwards `approval.respond` commands into the live adapter. Claude's
stdin control layer speaks the shared allow/deny/always-allow vocabulary (always-allow
degrades to a one-shot directive); ACP resolves the parked permission promise with the
matching option id. This closes the loop that previously left providers waiting forever.

## Deliberate scope cuts (post-V1 candidates)

- Persistent ACP connections (one process per session instead of per turn).
- `session/load` / native resume-id plumbing (`resumeOf` is still always null).
- Plan updates, elicitation forms, available-commands surfacing.
- Live probes for npx adapter kinds at boot (downloads packages); enable with
  `ARI_ACP_PROBE_ALL=1`.

## Verified

- 148 provider tests incl. scripted-agent ACP connection/driver flows and fixtures.
- Engine e2e: decision forwarding into a parked adapter.
- Live smoke (`npx tsx scripts/smoke-providers.ts`): all six CLIs detected; npm update
  checks answered; snapshot→live catalog upgrade; `opencode acp` returned 382 real
  models over ACP; `hermes acp` handshake clean.
