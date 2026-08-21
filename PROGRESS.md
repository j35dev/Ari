# PROGRESS — Ari build board

Single source of truth for task state. One task = one commit. Tick the box in the same
commit as the work. Claim format: `- [ ] M1.4 Button primitive (claimed @ feat/m1.4-button)`.

**Current milestone: M0**

---

## M0 — Scaffold

- [ ] M0.1 Charter docs committed & pushed (PLAN/AGENTS/PROGRESS/README/LICENSE)
- [ ] M0.2 Workspace + toolchain configs (pnpm workspace, tsconfig.base strict, eslint flat, prettier, editorconfig, gitattributes)
- [ ] M0.3 `@ari/shared` package: result, ids, jsonl reader/writer, logger + tests
- [ ] M0.4 `@ari/contracts` package: zod schemas, command/event unions skeleton + tests
- [x] M0.5 Electron main shell: app lifecycle, single-instance lock, BrowserWindow
- [x] M0.6 Preload bridge skeleton (contextBridge) + renderer React mount
- [x] M0.7 Verify pipeline green (`pnpm verify` = typecheck+lint+test) + `pnpm dev` runs
- [x] M0.8 docs/arch-00.md + tag `milestone/M0`

## M1 — Design system

- [ ] M1.1 Token system: oklch neutral ramp, accent ramp, spacing, radius, shadow, type scale (tokens.css)
- [ ] M1.2 Theme engine: ThemeProvider, CSS var bridge, 6 themes (Obsidian, Graphite, Porcelain, Ember, Verdant, Ultraviolet), persistence stub
- [x] M1.3 Fonts vendored: Geist + Geist Mono woff2, @font-face, tabular numerals utility (delivered via @fontsource-variable packages in M1.1 — same outcome, less fragility)
- [x] M1.4 Button + IconButton (variants, loading, kbd hint slot)
- [x] M1.5 Input + Textarea + Field wrapper (label, hint, error)
- [x] M1.6 Select (listbox popover, keyboard nav, typeahead)
- [x] M1.7 Popover + Tooltip (origin-aware menu-in motion)
- [x] M1.8 Dialog + Sheet (focus trap, scale-fade in)
- [x] M1.9 Tabs + SegmentedControl (animated indicator)
- [x] M1.10 Switch + Checkbox + Badge + Kbd
- [x] M1.11 ScrollArea + Skeleton + Spinner
- [x] M1.12 Toast system (queue, tones, actions, hover-pause; swipe dismiss deferred to M13.2)
- [ ] M1.13 Motion kit: named variants/hooks from PLAN §6.4 + reduced-motion respect
- [x] M1.14 Gallery route (/gallery) rendering every primitive + visual QA pass

## M2 — App shell

- [ ] M2.1 Platform chrome adapter: win titleBarOverlay / mac hiddenInset / linux custom controls
- [ ] M2.2 Titlebar component: drag regions, project chip, theme-synced overlay colors
- [ ] M2.3 Left rail: icon nav, active states, badge slots, tooltips
- [ ] M2.4 Sessions sidebar shell + collapse spring (width spring 320/34)
- [ ] M2.5 Router + view registry (TanStack Router memory history)
- [ ] M2.6 Status bar: engine dot, active runs, tokens/cost placeholder, mode chip
- [ ] M2.7 Command palette skeleton: overlay, fuzzy matcher, action registry
- [ ] M2.8 Settings shell routes (Appearance/Providers/Endpoints/Permissions/Keys/Advanced placeholders)
- [ ] M2.9 Empty states kit (illustrative glyph + copy + CTA)
- [ ] M2.10 Window-state persistence (bounds, maximized, sidebar prefs)
- [ ] M2.11 Single-instance focus behavior + tray skeleton (running count, quick-new)
- [ ] M2.12 docs/arch-02.md + tag `milestone/M2`

## M3 — Engine core

- [ ] M3.1 Contracts: full command/event unions + zod schemas for session/turn/message
- [ ] M3.2 JSONL journal: append w/ fsync policy, rotation, corruption-tail recovery + tests
- [ ] M3.3 Projection framework: fold events → read model, subscription deltas
- [ ] M3.4 Session state machine (idle/queued/running/waiting-approval/settled/error)
- [ ] M3.5 Turn state machine + turn lifecycle events
- [ ] M3.6 Typed IPC bridge: invoke channel map + subscribe streams, zod-validated
- [ ] M3.7 Preload API surface (`window.ari.rpc`) + renderer client
- [ ] M3.8 Zustand store factory bound to RPC subscriptions
- [ ] M3.9 Engine boot: replay journals on startup, reconcile read model
- [ ] M3.10 Command dispatcher: idempotency receipts, ordered queue
- [ ] M3.11 Settings store (JSON file, atomic write, schema versioning)
- [ ] M3.12 Crash-recovery tests (truncated tail, partial writes)
- [ ] M3.13 Logger service (file + devtools, redaction hook)
- [ ] M3.14 Error taxonomy + diagnostic event surfacing contract
- [ ] M3.15 Perf test: journal append < 1ms amortized; replay 100k events < 2s
- [ ] M3.16 docs/arch-03.md + tag `milestone/M3`

## M4 — Provider subsystem

- [ ] M4.1 Detector: PATH scan per-OS, well-known dirs, version probe, cache
- [ ] M4.2 Auth-status readers (read-only) for all six CLIs + graceful unknown states
- [ ] M4.3 Driver registry + adapter lifecycle supervision (respawn/backoff/dispose)
- [ ] M4.4 AgentEvent normalization union + contracts wiring
- [ ] M4.5 Fixture recorder script (`scripts/record-fixture.ts`)
- [ ] M4.6 Claude driver: spawn stream-json both directions + mapper + fixtures tests
- [ ] M4.7 Claude control protocol: approvals, steering, resume
- [ ] M4.8 Codex driver: `exec --json` mapper + fixtures tests
- [ ] M4.9 Codex resume + auth-status edge cases
- [ ] M4.10 OpenCode driver: probe flags at runtime, mapper + fixtures
- [ ] M4.11 Grok driver: probe flags at runtime, mapper + fixtures
- [ ] M4.12 Pi driver: probe flags at runtime, mapper + fixtures
- [ ] M4.13 Hermes driver: probe flags at runtime, mapper + fixtures
- [ ] M4.14 Model catalogs per driver + merge into provider picker data
- [ ] M4.15 Diagnostics card contract (flag drift, crash, auth-missing surfaces to UI)
- [ ] M4.16 Session↔driver binding: workspace cwd, env sanitization
- [ ] M4.17 Streaming backpressure + interrupt semantics per transport
- [ ] M4.18 Usage extraction (tokens/cost where providers emit it)
- [ ] M4.19 Provider health probes + status bar integration points
- [ ] M4.20 e2e-ish test: mock CLI script driven through registry end-to-end
- [ ] M4.21 Per-driver docs (docs/providers/*.md)
- [ ] M4.22 docs/arch-04.md + tag `milestone/M4`

## M5 — Transcript experience

- [ ] M5.1 Virtualized block list (TanStack Virtual), stable keys msgId#blockId
- [ ] M5.2 Markdown block splitter + memoized block renderer
- [ ] M5.3 Shiki highlighter pool (warmed once, async)
- [ ] M5.4 Streaming tail incremental re-parse
- [ ] M5.5 Text row: streaming veil fade, cursor pulse
- [ ] M5.6 Thinking row (collapsed by default, expand animation)
- [ ] M5.7 Tool card: args summary, collapsible raw JSON, duration, exit state
- [ ] M5.8 Diff card (delegates to shared diff viewer)
- [ ] M5.9 Error/diagnostic rows
- [ ] M5.10 Copy affordances + language chips on code blocks
- [ ] M5.11 Timestamps + usage footer per message
- [ ] M5.12 Stick-to-bottom spring + wheel-up interrupt + 70px re-engage band
- [ ] M5.13 Perf test: 50k-block synthetic transcript ≥55fps scroll
- [ ] M5.14 Transcript a11y pass (roles, announcements)

## M6 — Composer & steering

- [ ] M6.1 Auto-grow textarea (76–260px) + IME safety
- [ ] M6.2 Send→Steer→Stop morph button (180ms crossfade + width tween)
- [ ] M6.3 Queue-while-running (pending messages list, reorder, cancel)
- [ ] M6.4 @file fuzzy mentions fed by watcher index
- [ ] M6.5 Slash command registry + palette-style popup
- [ ] M6.6 Image paste/drop attachments
- [ ] M6.7 Drafts per session (persist, restore)
- [ ] M6.8 Model/provider/mode pickers (keyboard-first popovers)
- [ ] M6.9 Composer keybindings (Enter/Shift+Enter, history)
- [ ] M6.10 Composer unit + interaction tests

## M7 — Approvals & permissions

- [ ] M7.1 Approval event flow through engine (request/respond/idempotent)
- [ ] M7.2 Inline approval cards (approve/deny/always-allow)
- [ ] M7.3 Question panel (paged options, 1–9 keys, auto-advance)
- [ ] M7.4 Permission modes: ask / allow-edits / full — engine enforcement
- [ ] M7.5 Mode mapping per driver (claude control protocol, codex sandbox, ari-core gate)
- [ ] M7.6 Allowlist persistence + settings surface
- [ ] M7.7 Global approval badge + rail indicator
- [ ] M7.8 Approval flow tests (timeout, deny, double-respond)

## M8 — Checkpoints & diffs

- [ ] M8.1 GitService: porcelain v2 parsing, branch info, safe subprocess layer
- [ ] M8.2 Hidden-ref checkpoints `refs/ari/<session>/<turn>` capture
- [ ] M8.3 Revert reactor: workspace restore + conversation truncation
- [ ] M8.4 Per-turn & whole-thread diff queries
- [ ] M8.5 Unified diff parser → virtualized hunk model
- [ ] M8.6 Diff viewer: syntax-tinted lines, hunk nav, word-diff option
- [ ] M8.7 File-tree grouping + collapse tweens (180ms height)
- [ ] M8.8 Revert confirmation flow + undo toast
- [ ] M8.9 Non-git graceful degradation (checkpoints disabled notice)
- [ ] M8.10 Checkpoint storage GC (cap refs per session)
- [ ] M8.11 Diff perf test (10k-line diff virtualized)
- [ ] M8.12 docs/arch-08.md

## M9 — Projects/workspaces

- [ ] M9.1 Add-folder flow (dialog, recents, validation)
- [ ] M9.2 Project registry store + icon/color chips
- [ ] M9.3 Sidebar grouping by project + resort FLIP animation
- [ ] M9.4 Branch chip + quick switch popover
- [ ] M9.5 Watcher service (chokidar) + debounced fs events
- [ ] M9.6 Watcher→mentions index feed
- [ ] M9.7 Project settings (default provider/model/mode per project)
- [ ] M9.8 Unseen/activity markers on sessions

## M10 — Terminal & files

- [ ] M10.1 node-pty host service in main (spawn, resize, kill process tree)
- [ ] M10.2 xterm.js tabs in inspector pane
- [ ] M10.3 Terminal theme sync + font binding
- [ ] M10.4 Resize/input coalescing + scrollback replay (1MB cap)
- [ ] M10.5 Shell detection per platform + profile hints
- [ ] M10.6 File explorer tree (virtualized, watcher deltas)
- [ ] M10.7 File context actions (reveal in explorer, open in editor, copy path)
- [ ] M10.8 Binary/large-file guards
- [ ] M10.9 Terminal a11y + selection copy behaviors
- [ ] M10.10 Terminal stress test (fast-spew process, no dropped frames)

## M11 — Ari Core harness

- [ ] M11.1 Endpoint store CRUD + safeStorage encryption + encrypted-file fallback
- [ ] M11.2 OpenAI chat-completions client (SSE stream parser) + fixture tests
- [ ] M11.3 Anthropic messages client (SSE) + fixture tests
- [ ] M11.4 Ollama client + fixture tests
- [ ] M11.5 Connection tester (latency, /models listing) + UI hooks
- [ ] M11.6 Agent loop: tool round-trips, cancellation, retry policy
- [ ] M11.7 System prompt builder + workspace context injection
- [ ] M11.8 Tool: bash (pty, timeout, output cap)
- [ ] M11.9 Tools: read_file / write_file (path jail)
- [ ] M11.10 Tool: edit_file exact-string replace + diff preview event
- [ ] M11.11 Tools: glob / grep (rg if present else JS fallback)
- [ ] M11.12 Tool: todo_write (structured plan tracking)
- [ ] M11.13 Context-window manager (truncate/summarize oldest tool results)
- [ ] M11.14 Register as driver: transcript/approvals/checkpoints parity
- [ ] M11.15 Token accounting + cost estimate plumbing
- [ ] M11.16 Ari Core e2e test against scripted fake endpoint
- [ ] M11.17 Endpoint security review (header handling, SSRF guardrails)
- [ ] M11.18 docs/arch-11.md

## M12 — Settings & providers manager

- [ ] M12.1 Appearance page: live theme preview, accent override, density
- [ ] M12.2 Providers page: detect grid, auth badges, install hints, re-scan
- [ ] M12.3 Endpoints page: CRUD + test + key entry UX
- [ ] M12.4 Permissions page: modes default, allowlist editor
- [ ] M12.5 Keybindings page: logical map, Mod symbols, conflict detection
- [ ] M12.6 Advanced page: logs viewer, journal tools, diagnostics export
- [ ] M12.7 Settings events through engine (single writer)
- [ ] M12.8 Import/export settings bundle
- [ ] M12.9 Settings search (palette-integrated)
- [ ] M12.10 Settings a11y + keyboard traversal

## M13 — Polish & motion pass

- [ ] M13.1 Sidebar session-resort FLIP polish (260ms cubic-bezier(0.22,1,0.36,1))
- [ ] M13.2 Toast audit + queue behaviors
- [ ] M13.3 Skeleton/loading audit (no spinners >300ms)
- [ ] M13.4 prefers-reduced-motion full sweep
- [ ] M13.5 Focus-visible sweep + tab order audit
- [ ] M13.6 Keyboard map completion + cheat-sheet overlay (?)
- [ ] M13.7 Memory audit vs budgets (long-session soak)
- [ ] M13.8 Cold-start profiling vs 2.5s budget
- [ ] M13.9 Empty/error edge sweep (every pane)
- [ ] M13.10 UX copy pass (voice: precise, warm, zero fluff)
- [ ] M13.11 Boot splash + working-indicator signature moments
- [ ] M13.12 Notification-on-settle when unfocused

## M14 — Package & ship

- [ ] M14.1 electron-builder config: NSIS target + signing scaffolding
- [ ] M14.2 DMG universal target config
- [ ] M14.3 AppImage + deb targets
- [ ] M14.4 App icons (win/mac/linux) + installer assets
- [ ] M14.5 `pnpm dist` pipeline + artifact smoke checklist doc
- [ ] M14.6 Auto-update scaffolding (electron-updater, disabled by default) + README/docs final pass

## Stretch backlog (post-V1, unplanned)

- MCP client support
- ACP generic driver
- Remote/web companion (lift engine to sidecar)
- Plugin API
- Usage dashboards/heatmaps
- Git worktrees per session

---

## Blockers

| Task | Tried | Error essence | Status |
| --- | --- | --- | --- |

## Merge log

| PR | Task | Merged |
| --- | --- | --- |
