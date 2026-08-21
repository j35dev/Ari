# ARI — Master Build Plan

**ARI** (from Latin *arius* — "pertaining to, of the craft") is a cross-platform desktop
**Agentic Development Environment**: a beautiful, fast control surface that auto-detects the
coding agents already installed and authenticated on the machine (Claude Code, Codex,
OpenCode, Grok, Pi, Hermes), drives them through their native machine-readable protocols,
and additionally ships its own mini agentic harness (**Ari Core**) so any OpenAI-/
Anthropic-compatible custom endpoint becomes a full coding agent. No OAuth flows, no
accounts, no cloud. Windows / macOS / Linux.

**Pillars**

1. Zero-friction: launch → agents detected → working. Reuses existing CLI logins.
2. Premium UI/UX: solid layered surfaces (no glassmorphism dependency), full theme engine,
   choreographed motion.
3. Honest architecture: event-sourced sessions, typed contracts, every provider behind one
   adapter interface.
4. Agent-buildable: every task in PROGRESS.md is commit-sized, verifiable, and resumable
   across sessions and across agents.

---

## 1. Stack (pinned)

| Layer | Choice | Notes |
| --- | --- | --- |
| Shell | Electron (current stable) | `titleBarStyle:'hidden'` + platform chrome adapter |
| Language | TypeScript 5.x, `strict`, ESM only | |
| Build | electron-vite + pnpm workspaces | one `pnpm dev`, one `pnpm verify` |
| Renderer UI | React 19 + Zustand + TanStack Router (memory) + TanStack Virtual | |
| Styling | Tailwind CSS v4 (CSS-first `@theme` tokens) | tokens = oklch design system |
| Motion | motion/react + CSS transitions | catalog in §6.4 |
| Markdown/code | remark suite + Shiki (block-memoized) | §6.5 |
| Terminal | node-pty + xterm.js | only native dep; `electron-builder install-app-deps` |
| Git | `git` subprocess (porcelain v2) | no libgit2 |
| Persistence | JSONL event journals + JSON settings | zero native DB; crash-safe append |
| Secrets | Electron safeStorage (+ encrypted-file fallback on Linux) | endpoint keys |
| Icons/fonts | lucide-react; Geist + Geist Mono woff2 vendored (OFL) | distinctive, not default-AI |
| Test | Vitest + recorded protocol fixtures | no CLIs needed in CI |

## 2. Monorepo layout

```
D:\Projects\Ari
├─ PLAN.md  AGENTS.md  PROGRESS.md     # operating system for builder agents
├─ apps/
│  └─ desktop/            # electron-vite app: src/main, src/preload, src/renderer
├─ packages/
│  ├─ contracts/          # shared types: RPC channel map, events, commands, settings schemas
│  ├─ engine/             # session store, event log, orchestration, checkpointing, git service
│  ├─ providers/          # detector + driver registry + one folder per driver + fixtures/
│  ├─ ari-core/           # built-in harness: agent loop, tools, endpoint clients
│  ├─ ui/                 # design system: tokens, themes, primitives, motion kit, fonts
│  └─ shared/             # utils: jsonl, ids, result types, logger, zod helpers
├─ scripts/               # dev runner, fixture recorder, package scripts
└─ docs/                  # architecture notes per milestone (arch-00.md …)
```

Import rule: narrow subpath exports only (`@ari/providers/claude`), no barrels.
Renderer lives inside `apps/desktop/src/renderer` per electron-vite convention; all UI code
is imported from `@ari/ui` + feature modules, keeping it portable.

## 3. Process architecture

```
┌─────────────────────────── Electron ────────────────────────────┐
│ Main process = SUPERVISOR + ENGINE HOST                          │
│  • window/tray/chrome adapter/single-instance lock               │
│  • Engine: event-sourced session store (JSONL journals)          │
│  • DriverRegistry → spawns provider CLIs (node-pty / childproc)  │
│  • AriCore runtime · GitService · TerminalService · Watcher      │
│        ▲  typed IPC (contextBridge, allowlisted channels)        │
│  Preload: window.ari.rpc.invoke / .subscribe (validated)         │
│        ▲                                                         │
│ Renderer (sandboxed, no Node): React UI ← Zustand stores ← RPC   │
└──────────────────────────────────────────────────────────────────┘
```

- Engine in main process ⇒ no loopback ports ⇒ no Windows firewall prompt.
- Event-sourced core: renderer dispatches **commands** → engine appends **events** to
  journal → projects read-model → pushes deltas to subscribers.
  Commands: `session.create`, `turn.start`, `turn.interrupt`, `message.enqueue`,
  `approval.respond`, `checkpoint.revert`, `settings.update`, …
  Events: `user.message.added`, `assistant.delta`, `tool.started/completed`,
  `approval.requested`, `turn.settled`, `checkpoint.captured`, …
- Every turn bracketed by a **checkpoint** (hidden git ref `refs/ari/<sessionId>/<turn>`)
  when the project is a git repo; revert restores workspace + truncates conversation.

## 4. Provider subsystem

### 4.1 Detection (no auth ever asked)

Scan PATH + well-known install dirs for binaries; probe `--version`; read each CLI's own
credential store **read-only** to report auth status.

| Driver | Binary | Transport | Auth reused from |
| --- | --- | --- | --- |
| claude | `claude` | `-p --input-format stream-json --output-format stream-json --verbose` + control protocol (permissions, steering, resume) | `~/.claude*` credentials/keychain |
| codex | `codex` | `exec --json` JSONL events; `app-server` JSON-RPC for rich control; `resume` | `~/.codex/auth.json` |
| opencode | `opencode` | JSON run mode / serve API (probe at build) | opencode auth.json |
| grok | `grok` | JSON mode (probe at build) | grok CLI config |
| pi | `pi` | JSON mode (probe at build) | pi config |
| hermes | `hermes` | JSON mode (probe at build) | hermes config |
| ari-core | *(internal)* | direct HTTP to user-defined endpoints | keys user pastes (safeStorage) |

### 4.2 Driver interface (one shape, all providers)

```ts
interface Driver {
  kind: DriverKind
  detect(): Promise<Detection>            // binary? version? authed? models?
  create(cfg): Promise<Adapter>
}
interface Adapter {
  start(session): AsyncIterable<AgentEvent>
  send(msg | steer | interrupt | respondApproval): void
  setMode(mode: PermissionMode): void
  listModels(): ModelInfo[]
  dispose(): Promise<void>
}
```

`AgentEvent` is Ari's normalized union (text delta, thinking, tool call w/ args, tool
result, usage, approval request, error, done). Each driver folder contains `mapper.ts`
(native→normalized) + `__fixtures__/*.jsonl` recorded once from real CLIs via
`scripts/record-fixture.ts`, so all mapping logic is unit-tested offline. Unknown/changed
CLI flags fail soft with a surfaced diagnostic card, never a crash.

## 5. Ari Core (custom-endpoint harness)

- Endpoint CRUD: name, base URL, API flavor (`openai/chat-completions` | `anthropic/messages`
  | `ollama`), key (safeStorage), model id, headers. Connection tester with latency +
  `/models` listing.
- Agent loop: streaming SSE → normalized events; tool-calling round-trips; system prompt w/
  workspace context; context-window guardrail (truncate/summarize oldest tool results).
- Tools (same pipeline as external agents → identical approval UI): `bash` (pty, cwd=
  workspace, timeout), `read_file`, `write_file`, `edit_file` (exact string replace w/ diff
  preview), `glob`, `grep` (ripgrep if present else JS), `todo_write`. Path-jail inside
  workspace root; bash gated by permission mode.
- Appears in UI as just another provider ("Ari Core") with per-endpoint model entries.

## 6. UI/UX specification (the differentiator)

### 6.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│ custom titlebar (drag) · project chip · branch · search ⌘K   │
├───┬──────────────┬──────────────────────────────┬────────────┤
│ R │ Sessions     │ Transcript (virtualized)     │ Inspector  │
│ a │ sidebar      │                              │ (diff/files│
│ i │ (collapsible │  streaming markdown          │ /terminal  │
│ l │ 240↔0px      │  tool cards · approvals      │ tabs)      │
│ 56 │ spring)     │                              │ collapsible│
├───┴──────────────┴──────────────────────────────┴────────────┤
│ status bar: engine dot · active runs · tokens/cost · mode    │
└──────────────────────────────────────────────────────────────┘
```

Left rail: Sessions, Projects, Terminal, Changes (git), Settings. Command palette overlays
everything.

### 6.2 Design language ("engineered calm", explicitly anti-generic-AI)

- **Surfaces, not glass**: opaque layered panels, 1px hairline borders (oklch neutral ramp),
  depth via elevation steps + subtle inner strokes. Windows-safe by construction.
- Type: Geist (UI) / Geist Mono (code, numbers); display sizes tight-tracked; tabular
  numerals for stats; 13px base density like pro tools.
- Radius scale 6/10/14; visible focus rings; skeletons never spinners for >300ms loads.
- Signature moments: boot splash wordmark pulse; working indicator = rotating matrix glyph
  + flavour word ("forging…"); turn-complete flash of the rail icon.

### 6.3 Themes (first-class, ≥6 ship in v1)

Token-driven (`--bg, --surface-1..3, --border, --fg, --muted, --accent…` in oklch):
**Obsidian** (default dark), **Graphite**, **Porcelain** (light), **Ember**, **Verdant**,
**Ultraviolet** + accent override picker + `prefers-reduced-motion` respect. Titlebar
overlay colors sync with theme.

### 6.4 Motion catalog (exact timings)

| Name | Spec |
| --- | --- |
| fade-in-up | 220ms cubic-bezier(0.16,1,0.3,1), translateY 4→0 |
| menu/popover-in | 140ms scale .96→1 + fade, origin-aware |
| sidebar-collapse | width spring (stiffness 320 / damping 34), content crossfade |
| session-resort | FLIP slide 260ms cubic-bezier(0.22,1,0.36,1) |
| composer morph | Send→Steer→Stop 180ms icon crossfade + width tween |
| transcript tail | stick-to-bottom spring; wheel-up interrupts, re-engage band 70px |
| pane slide | 200ms ease-out width/height tweens |
| streaming veil | opacity fade on appended text (paint-only, never layout) |

### 6.5 Transcript engineering

Block-granular virtualization (row = markdown block / tool group, stable key
`msgId#blockId`), height memoization keyed (id,len,width), incremental re-parse of
streaming tail only, Shiki highlighter warmed once, code blocks with copy + language chip,
tool cards (args summary, collapsible raw, duration, exit state), diff cards rendered by
the shared diff viewer.

## 7. Screens/features inventory (V1 complete surface)

Sessions sidebar (grouped by project, attention-sorted, unseen dots, archive/search) ·
New Session canvas (project+provider+model+mode pickers) · Transcript · Composer
(auto-grow, queue while running, @file mentions, slash commands, image paste, drafts) ·
Approval center (inline cards + global badge) · Question panel · Diff/Changes pane
(per-turn & whole-thread, file collapse, hunk nav, revert) · Terminal tabs · File explorer
· Git panel (status/branch/stage-lite) · Command palette (fuzzy, actions+nav) · Settings:
Appearance / Providers / Endpoints / Permissions / Keybindings / Advanced · Tray ·
Notifications on settle when unfocused · Usage meter (tokens + est. cost) · Keybindings
layer.

## 8. Cross-platform matrix

| Concern | Strategy |
| --- | --- |
| Window chrome | Platform adapter seam: Windows = titleBarOverlay; macOS = hiddenInset traffic lights; Linux = custom min/max/close buttons. Drag regions everywhere |
| Keybindings | One logical map, `Mod` = Ctrl/⌘ per platform; editor renders correct symbols |
| Secrets | safeStorage: DPAPI / Keychain / libsecret-kwallet + encrypted-file fallback when no keyring |
| CLI detection | Per-OS search paths: `%LOCALAPPDATA%`, `where.exe` + `.cmd` shims (Win); `/opt/homebrew/bin`, `~/.local/bin` (mac/Linux); npm-global dirs |
| Terminal | node-pty everywhere (ConPTY / Unix PTY) |
| Packaging | NSIS installer, DMG (universal), AppImage + deb |
| Rendering | Fonts vendored → pixel-identical themes on all OSes |

## 9. Security

Sandboxed renderer, `contextIsolation: true`, no `nodeIntegration`; IPC allowlist +
zod-validated payloads; secrets only via safeStorage, never logged; path jail for all file
tools; external links via shell with confirm; CSP default-src 'self'.

## 10. Performance budgets

Cold start ≤ 2.5s to interactive shell; session switch ≤ 100ms; streaming keystroke-to-paint
≤ 16ms/frame; idle RAM ≤ 350MB; 50k-message transcript scroll ≥ 55fps; journal append
amortized < 1ms/event.

## 11. Milestones

Full task-level board lives in **PROGRESS.md** (single source of truth). Summary:

- **M0 Scaffold** — charter docs, workspace toolchain, shared+contracts packages, electron
  hello window, verify pipeline.
- **M1 Design system** — oklch tokens, 6 themes, fonts, ~18 primitives, motion kit, gallery.
- **M2 App shell** — chrome adapter, rail, sidebar, router, palette skeleton, tray.
- **M3 Engine core** — contracts, journals, projections, state machines, typed IPC bridge.
- **M4 Providers** — detector, registry, fixture recorder, six drivers, catalogs.
- **M5 Transcript** — virtualization, markdown, streaming, tool cards, tail spring.
- **M6 Composer & steering** — input, morph button, queue, mentions, slash commands.
- **M7 Approvals & permissions** — cards, question panel, modes, allowlists.
- **M8 Checkpoints & diffs** — git refs, capture/revert, unified diff viewer.
- **M9 Projects/workspaces** — folders, grouping, branch chip, watcher.
- **M10 Terminal & files** — pty host, xterm tabs, explorer tree.
- **M11 Ari Core** — endpoints, protocol clients, agent loop, tools.
- **M12 Settings & providers manager** — all pages live.
- **M13 Polish & motion pass** — FLIP resort, toasts, reduced-motion, perf audits.
- **M14 Package & ship** — NSIS/DMG/AppImage/deb, icons, update scaffolding.

Stretch (post-V1): MCP client, ACP generic driver, remote/web companion, plugin API,
usage dashboards, worktrees.

## 12. Execution architecture (orchestrator + fleet)

- **Phase A — solo spine:** M0 scaffold + charter docs + verify pipeline land on `main`
  immediately, small commits pushed continuously.
- **Phase B — parallel fleet:** herdr-managed opencode workers, one git worktree + branch
  per task, prompted from the PROGRESS.md board; each worker opens a PR; orchestrator
  reviews and merges via a queue. Lockfile & root manifests reserved for the orchestrator.
  Scale 4→8 workers by review throughput. Solo fallback at same commit cadence.
- Commit granularity: target ≤ ~400 changed lines per commit; PRs < ~800 lines. 3k+
  commits over the project lifetime is expected and desired.

## 13. Risks & mitigations

- Exact CLI flags for grok/pi/hermes/opencode are verified empirically in M4 via the
  probe-and-fixtures procedure rather than assumed; fixtures make mapping testable offline.
- node-pty is the only native dependency; isolated to desktop packaging step.
- Fleet merge conflicts: workers never touch lockfiles/root configs; task board marks
  dependencies; orchestrator serializes overlapping areas.
