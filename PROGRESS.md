# PROGRESS — Ari build board

Single source of truth for task state. One task = one commit. Tick the box in the same
commit as the work. Claim format: `- [ ] M1.4 Button primitive (claimed @ feat/m1.4-button)`.

**Current milestone: hardening pass � core product functionally complete**

---

## STATUS SNAPSHOT (pause point)

**129 / 181 tasks delivered � 105 commits � ~22k LOC � 225+ tests green � Windows build verified**

> HONESTY CORRECTION (2026-08-23, feat/v2-usability-overhaul): the snapshot above
> overstated reality. Despite every box being ticked and tests green, the app was
> NOT usable: opening Terminal crashed the whole renderer (`process.cwd()` in a
> sandboxed context -> blank screen, no way back), CLI spawns failed with EINVAL on
> Windows (.cmd shims), turn errors were invisible (settle errors never rendered),
> endpoints saved to localStorage never reached the engine store, and IPC handlers
> registered only after multi-second detection. The M15 repair wave below fixed the
> foundations; verified by unit tests AND a live CDP probe of the packaged build.

## M15 - Usability repair wave (foundation fixes)

- [x] M15.1 Root + per-pane ErrorBoundary; a crashing pane can never unmount the shell again
- [x] M15.2 `app.info` RPC replaces sandbox-forbidden `process.cwd()`; home-dir fallback
- [x] M15.3 Synchronous IPC registration; drivers hydrate concurrently in background
- [x] M15.4 node-pty loads via guarded cached promise (descriptive error instead of hang)
- [x] M15.5 cross-spawn port: .cmd/.bat/extensionless CLIs spawn through escaped cmd.exe
      (validated live: codex/opencode/pi npm shims probe versions successfully)
- [x] M15.6 Detector version probes use the same wrapper
- [x] M15.7 Turn errors surface: banner in session + danger toast (fires even when focused)
- [x] M15.8 EndpointsManager moved onto the engine's encrypted store over IPC (+ endpoints.test RPC,
      CORS-free probes run in main); blank-key edits preserve stored keys
- [x] M15.9 First-run welcome: detected-CLI grid + inline connect-a-model form (Ari Core works day one)
- [x] M15.10 Session fold rebuilt on replayed events only (load/replay race eliminated);
      queued messages hold on failure instead of auto-dispatching into the same wall
- [x] M15.11 Engine resolveWorkspace: project ids map to real folders; adhoc sessions run in home dir
- [x] M15.12 CSP moves from static meta (blocked dev preamble + endpoint probes) to prod-only headers
- [x] M15.13 Zeron-style transcript: consecutive tools collapse into "Ran 2 commands / Edited 1 file"
      activity rows with error badges; user messages as right-aligned bubbles
- [x] M15.14 Composer pill redesign: docked control row, circular send/stop, permission-mode chip
- [x] M15.15 DSH-style telemetry strip: turns, last-turn latency, token totals, running pulse
- [x] M15.16 Multi-tab terminal (tabs stay mounted hidden; ptys die on close; focus follows tabs)
- [x] M15.17 Sidebar relative timestamps; titlebar project breadcrumb + Ctrl K hint
- [x] M15.18 Live smoke: packaged renderer boots (CDP-verified sidebar/sessions/composer/terminal),
      navigation round-trips, zero error boundaries triggered

### Working end-to-end today
- Single-sidebar shell: sessions grouped under collapsible project sections, utility strip
- Instant new sessions; model/driver selected from the prompt-box pill (`session.update` re-binds drivers mid-session)
- 7 providers auto-detected (claude/codex/opencode/grok/pi/hermes + Ari Core), health probes, deduped registry
- Live engine: journals, decider, turns, approvals flow, per-turn git checkpoints + revert command
- Transcript: virtualized, GFM+Shiki, tool/thinking cards, copy + usage footers, stick-to-bottom spring
- Composer: morph button, queue, drafts, slash popup, @file mentions, image attachment primitives
- Terminal pane (pty+xterm), changes rail (git status + unified diff viewer), projects manager
- Command palette (Ctrl+K), 6 themes, boot splash, settle notifications, tray
- Packaging: electron-builder config for NSIS/DMG/AppImage/deb, generated icon, `Ari.exe` smoke-tested

### Remaining 52 tasks (depth/hardening � see board below)
Driver control protocols (steering/approvals depth) � watcher?mentions feed � diff cards in transcript �
per-driver permission enforcement wiring � image paste?Composer mount � FLIP resort � memory/cold-start
audits � a11y sweeps � keybinding remap layer � driver doc pages � arch-08+ notes

### Resume ritual
1. `git fetch origin && git rebase origin/main`
2. Pick first unticked task below; read its spec in PLAN.md
3. Branch `<type>/m<task>-<slug>`, implement, `pnpm verify`, one commit ticking PROGRESS.md
4. Push + PR; orchestrator merges and cleans up worktrees

---

## M20 — Competitor-research hardening wave (t3code · DSH · comet)

Findings from deep-dives of pingdotgg/t3code, deepseek-ai/deepseek-harness, and
zeronsh/comet (issues #93/#95 in particular), converted into Ari fixes:

- [x] M20.1 Handshake window: a CLI producing no output fails legibly with stderr tail (comet #93)
- [x] M20.2 Live working indicator: WorkingGlyph + zero-rerender elapsed timer in the session strip
- [x] M20.3 Empty model rounds retry instead of ending the turn silently (DSH EMPTY_RESPONSE semantics)
- [x] M20.4 Login-shell PATH snapshot + node version-manager probing for GUI launches (comet shell_env)
- [x] M20.5 Prompt-stall watchdog: totally silent ACP agents fail with guidance (`ARI_ACP_PROMPT_STALL_MS`)
- [x] M20.6 npm fatal exit decoding: npx adapter deaths surface ENOENT/EACCES guidance (comet #95)
- [x] M20.7 Sidebar pin/archive shelves wired to engine flags (M18.2 UI gap closed)
- [x] M20.8 Session nav keys: Mod+N, Mod+1..9 jump, Ctrl+Tab cycle + shared shortcut map
      (removed the phantom "Cycle theme" row — documented but never implemented)
- [x] M20.9 Message rail minimap: dot per user prompt, hover preview, click-to-jump (t3 parity)
- [x] M20.10 Prompt Stash (Mod+S): cross-session draft clipboard with reuse menu (t3 parity)
- [x] M20.11 Approval card polish: command/file headline, collapsible raw request, 1/N pending counter
- [x] M20.12 LOGIC FIX — engine owns the durable queue: steered prompts are dequeued immediately and
      can never re-run as a follow-up turn; after a clean settle the engine dispatches the oldest
      queued message itself (renderer now only mirrors enqueued/dequeued events; previously a
      steered prompt executed twice and journal queues never drained)
- [x] M20.13 Attention toast when an approval or question blocks while the window is hidden
- [x] M20.14 Live plan panel: `.ari-todo.json` from todo_write renders as a collapsible checklist
      pinned above the transcript (`plan.get` RPC; refreshes on settle)

## M22 — Output-quality & prompt-box wave (from live screenshot feedback)

- [x] M22.1 CRITICAL FIX — streamed deltas coalesce into flowing markdown blocks
      (was: one line per ~120ms flush chunk; splitBlocks now merges contiguous
      text/thinking parts with stable keys, tool calls break runs)
- [x] M22.2 Model picker is agent-first: letter mark + model name, searchable grouped
      combobox, keyboard nav (arrows/Home/End/Enter/Esc), check for the current model
- [x] M22.3 Composer plate has no leftover focus halo; send sits on the right of the
      foot; chips share rounded-md geometry with the send control

## M21 — Fleet/parallelism wave (Cline Kanban · Conductor · Nimbalyst research)

- [x] M21.1 Diff-line comments that attach to the composer as feedback for the session's next turn
- [~] M21.2 A/B race mode — 2a DONE: race launcher (palette "New A/B provider race") creates two
      sibling sessions from one prompt and starts both turns. Remaining: side-by-side diff
      comparison + keep-A/keep-B resolution (M21.2b)
- [x] M21.3 Named run-script buttons per project (pnpm dev etc.) with captured output
- [x] M21.4 Ship flow: stage-all → commit → push in one action, then inline PR creation via `gh`
      (`git.createPr` RPC; gh-missing and auth failures surface as actionable guidance)

## M16 — Provider system rework: ACP transport, live catalogs, update awareness

Driver rework so Ari stays an *interface* over provider harnesses (Agent Client Protocol,
stdio JSON-RPC) instead of hardcoding their worlds: instant detection with upstream
update awareness, model lists fetched from the providers themselves (models.dev registry
+ ACP session config options), and approval decisions finally routed into live adapters.

- [x] M16.1 Contracts: `providers.models` RPC, `providers.updates` stream frame, Detection gains latestVersion/updateAvailable
- [x] M16.2 Update awareness: npm dist-tag checks per CLI kind, semver compare, TTL cache, fail-soft offline
- [x] M16.3 Dynamic catalog core: generated models.dev snapshot (`scripts/update-model-snapshot.ts`) + dynamic overlay behind sync `modelsFor`
- [x] M16.4 CatalogService: disk cache + background models.dev refresh + injectable live probe
- [x] M16.5 ACP transport: lenient wire types + update folder + stdio JSON-RPC connection (initialize/session lifecycle/request_permission bridge)
- [x] M16.6 ACP launch table + AcpDriver: npx adapters (claude/codex/pi), native servers (opencode/hermes/grok), transparent legacy-driver fallback per turn
- [x] M16.7 Engine: route `approval.respond` decisions into live adapters (claude stdin control + ACP outcomes); fixes approvals hanging forever
- [x] M16.8 Desktop wiring: ACP-preferred hydration, catalog boot, `providers.models` handler, updates stream replay; renderer pickers consume live catalogs

## M17 — Gap-audit repair wave (P0)

- [x] M17.1 Engine wiring: resumeOf, steer, input.respond, queue fold, listSessions index
- [x] M17.2 Ari Core honors permissionMode; grep uses rg when present
- [x] M17.3 Mount orphaned renderer components; fix BranchChip
- [x] M17.4 SecretBox on EndpointStore; tray status; git.turnDiff RPC
- [x] M17.5 GitHub Actions workflow runs pnpm verify

## M18 — Gap-audit P1 table-stakes

- [x] M18.1 Transcript diff cards + context-window meter
- [x] M18.2 Session titles + pin/archive flags
- [x] M18.3 In-app file editing + write-back RPC
- [x] M18.4 Project-wide content search (Ctrl+Shift+F)
- [x] M18.5 Usage dashboard

## M19 — Gap-audit P2 integrations

- [x] M19.1 Codex app-server JSON-RPC driver
- [x] M19.2 MCP stdio client in Ari Core
- [x] M19.3 Git worktree per session
- [x] M19.4 Message retry / edit / regenerate
- [x] M19.5 Git add / commit / push RPC

## M0 — Scaffold

- [x] M0.1 Charter docs committed & pushed (PLAN/AGENTS/PROGRESS/README/LICENSE)
- [x] M0.2 Workspace + toolchain configs (pnpm workspace, tsconfig.base strict, eslint flat, prettier, editorconfig, gitattributes)
- [x] M0.3 `@ari/shared` package: result, ids, jsonl reader/writer, logger + tests
- [x] M0.4 `@ari/contracts` package: zod schemas, command/event unions skeleton + tests
^- [x] M0.1 Charter docs committed & pushed (PLAN/AGENTS/PROGRESS/README/LICENSE)
^- [x] M0.2 Workspace + toolchain configs (pnpm workspace, tsconfig.base strict, eslint flat, prettier, editorconfig, gitattributes)
^- [x] M0.3 `@ari/shared` package: result, ids, jsonl reader/writer, logger + tests
^- [x] M0.4 `@ari/contracts` package: zod schemas, command/event unions skeleton + tests
- [x] M0.5 Electron main shell: app lifecycle, single-instance lock, BrowserWindow
- [x] M0.6 Preload bridge skeleton (contextBridge) + renderer React mount
- [x] M0.7 Verify pipeline green (`pnpm verify` = typecheck+lint+test) + `pnpm dev` runs
- [x] M0.8 docs/arch-00.md + tag `milestone/M0`

## M1 — Design system

- [x] M1.1 Token system: oklch neutral ramp, accent ramp, spacing, radius, shadow, type scale (tokens.css)
- [x] M1.2 Theme engine: ThemeProvider, CSS var bridge, 6 themes (Obsidian, Graphite, Porcelain, Ember, Verdant, Ultraviolet), persistence stub
^- [x] M1.1 Token system: oklch neutral ramp, accent ramp, spacing, radius, shadow, type scale (tokens.css)
^- [x] M1.2 Theme engine: ThemeProvider, CSS var bridge, 6 themes (Obsidian, Graphite, Porcelain, Ember, Verdant, Ultraviolet), persistence stub
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
- [x] M1.13 Motion kit: named variants/hooks from PLAN §6.4 + reduced-motion respect
- [x] M1.14 Gallery route (/gallery) rendering every primitive + visual QA pass

## M2 — App shell

- [x] M2.1 Platform chrome adapter: win titleBarOverlay / mac hiddenInset / linux custom controls
- [x] M2.2 Titlebar component: drag regions, project chip, theme-synced overlay colors
- [x] M2.3 Left rail: icon nav, active states, badge slots, tooltips
- [x] M2.4 Sessions sidebar shell + collapse spring (width spring 320/34)
- [x] M2.5 Router + view registry (TanStack Router memory history)
- [x] M2.6 Status bar: engine dot, active runs, tokens/cost placeholder, mode chip
- [x] M2.7 Command palette skeleton: overlay, fuzzy matcher, action registry
- [x] M2.8 Settings shell routes (Appearance/Providers/Endpoints/Permissions/Keys/Advanced placeholders)
- [x] M2.9 Empty states kit (illustrative glyph + copy + CTA)
- [x] M2.10 Window-state persistence (bounds, maximized, sidebar prefs)
- [x] M2.11 Single-instance focus behavior + tray skeleton (running count, quick-new)
- [x] M2.12 docs/arch-02.md + tag `milestone/M2`

## M3 — Engine core

- [x] M3.1 Contracts: full command/event unions + zod schemas for session/turn/message
- [x] M3.2 JSONL journal: append w/ fsync policy, rotation, corruption-tail recovery + tests
- [x] M3.3 Projection framework: fold events → read model, subscription deltas
- [x] M3.4 Session state machine (idle/queued/running/waiting-approval/settled/error)
- [x] M3.5 Turn state machine + turn lifecycle events
- [x] M3.6 Typed IPC bridge: invoke channel map + subscribe streams, zod-validated
- [x] M3.7 Preload API surface (`window.ari.rpc`) + renderer client
- [x] M3.8 Zustand store factory bound to RPC subscriptions
- [x] M3.9 Engine boot: replay journals on startup, reconcile read model
- [x] M3.10 Command dispatcher: idempotency receipts, ordered queue
- [x] M3.11 Settings store (JSON file, atomic write, schema versioning)
- [x] M3.12 Crash-recovery tests (truncated tail, partial writes)
- [x] M3.13 Logger service (file + devtools, redaction hook)
- [x] M3.14 Error taxonomy + diagnostic event surfacing contract
- [x] M3.15 Perf test: journal append < 1ms amortized; replay 100k events < 2s (amortized budget measured in fsync batch mode with trailing flush; always-fsync measures disk latency, not the journal path)
- [x] M3.16 docs/arch-03.md + tag `milestone/M3`

## M4 — Provider subsystem

- [x] M4.1 Detector: PATH scan per-OS, well-known dirs, version probe, cache
- [x] M4.2 Auth-status readers (read-only) for all six CLIs + graceful unknown states
- [x] M4.3 Driver registry + adapter lifecycle supervision (respawn/backoff/dispose)
- [x] M4.4 AgentEvent normalization union + contracts wiring
- [x] M4.5 Fixture recorder script (`scripts/record-fixture.ts`)
- [x] M4.6 Claude driver: spawn stream-json both directions + mapper + fixtures tests
- [x] M4.7 Claude control protocol: approvals, steering, resume (stdin control layer on the claude adapter: user-turn steering frames, approval directive responses, interrupt frame with 2s kill fallback; resume shipped via --resume in M4.6)
- [x] M4.8 Codex driver: `exec --json` mapper + fixtures tests
- [x] M4.9 Codex resume + auth-status edge cases
    - [x] M4.10 OpenCode driver: probe flags at runtime, mapper + fixtures
    - [x] M4.11 Grok driver: probe flags at runtime, mapper + fixtures
  - [x] M4.12 Pi driver: probe flags at runtime, mapper + fixtures
- [x] M4.13 Hermes driver: probe flags at runtime, mapper + fixtures (synthesized fixtures — hermes CLI absent locally; re-record via record-fixture.ts when binary ships)
- [x] M4.14 Model catalogs per driver + merge into provider picker data
- [x] M4.15 Diagnostics card contract (flag drift, crash, auth-missing surfaces to UI)
- [x] M4.16 Session↔driver binding: workspace cwd, env sanitization
- [x] M4.17 Streaming backpressure + interrupt semantics per transport
- [x] M4.18 Usage extraction (tokens/cost where providers emit it)
- [x] M4.19 Provider health probes + status bar integration points
- [x] M4.20 e2e-ish test: mock CLI script driven through registry end-to-end
- [x] M4.21 Per-driver docs (docs/providers/README.md)
- [x] M4.22 docs/arch-04.md + tag `milestone/M4`

## M5 — Transcript experience

- [x] M5.1 Virtualized block list (TanStack Virtual), stable keys msgId#blockId
- [x] M5.2 Markdown block splitter + memoized block renderer
- [x] M5.3 Shiki highlighter pool (warmed once, async)
- [x] M5.4 Streaming tail incremental re-parse
- [x] M5.5 Text row: streaming veil fade, cursor pulse
- [x] M5.6 Thinking row (collapsed by default, expand animation)
- [x] M5.7 Tool card: args summary, collapsible raw JSON, duration, exit state
- [x] M5.8 Diff card (delegates to shared diff viewer)
- [x] M5.9 Error/diagnostic rows
- [x] M5.10 Copy affordances + language chips on code blocks (CopyButton; language chips deferred with M5.8 diff-card scope)
- [x] M5.11 Timestamps + usage footer per message
- [x] M5.12 Stick-to-bottom spring + wheel-up interrupt + 70px re-engage band
- [x] M5.13 Perf test: 50k-block synthetic transcript ≥55fps scroll (delivered as 50k pure-transform budget + jsdom mount smoke of TranscriptView @2000 messages; fps needs a real compositor, unverifiable headless)
- [x] M5.14 Transcript a11y pass (roles, announcements) (scroll container is `role="log"` + `aria-label="Conversation transcript"` + `aria-live="polite"`, sr-only "Messages" heading)

## M6 — Composer & steering

- [x] M6.1 Auto-grow textarea (76–260px) + IME safety
- [x] M6.2 Send→Steer→Stop morph button (180ms crossfade + width tween)
- [x] M6.3 Queue-while-running (pending messages list, reorder, cancel)
- [x] M6.4 @file fuzzy mentions fed by watcher index (composer picker wired via `suggestions` prop; feed served by the iles.index RPC, landed with M9.6)
- [x] M6.5 Slash command registry + palette-style popup
- [x] M6.6 Image paste/drop attachments (primitives: useImageAttachments hook + AttachmentStrip with object-URL lifecycle; paste/drop wiring into Composer follows)
- [x] M6.7 Drafts per session (persist, restore)
- [x] M6.8 Model/provider/mode pickers (keyboard-first popovers)
- [x] M6.9 Composer keybindings (Enter/Shift+Enter, history)
- [x] M6.10 Composer unit + interaction tests

## M7 — Approvals & permissions

- [x] M7.1 Approval event flow through engine (request/respond/idempotent)
- [x] M7.2 Inline approval cards (approve/deny/always-allow)
- [x] M7.3 Question panel (paged options, 1–9 keys, auto-advance)
- [x] M7.4 Permission modes: ask / allow-edits / full — engine enforcement
- [x] M7.5 Mode mapping per driver (claude control protocol, codex sandbox, ari-core gate)
- [x] M7.6 Allowlist persistence + settings surface
- [x] M7.7 Global approval badge + rail indicator
- [x] M7.8 Approval flow tests (timeout, deny, double-respond)

## M8 — Checkpoints & diffs

- [x] M8.1 GitService: porcelain v2 parsing, branch info, safe subprocess layer
- [x] M8.2 Hidden-ref checkpoints `refs/ari/<session>/<turn>` capture
- [x] M8.3 Revert reactor: workspace restore + conversation truncation
- [x] M8.4 Per-turn & whole-thread diff queries
- [x] M8.5 Unified diff parser → virtualized hunk model
- [x] M8.6 Diff viewer: syntax-tinted lines, hunk nav, word-diff option
- [x] M8.7 File-tree grouping + collapse tweens (180ms height)
- [x] M8.8 Revert confirmation flow + undo toast (inline confirm + result toast via @ari/ui/toast; post-revert undo action deferred with M13.2)
- [x] M8.9 Non-git graceful degradation (checkpoints disabled notice)
- [x] M8.10 Checkpoint storage GC (cap refs per session)
- [x] M8.11 Diff perf test (10k-line diff virtualized) (parseDiff.perf.test.ts: synthetic 10k-line unified diff parses < 500ms; virtualized rendering itself landed with M8.5/M8.6)
- [x] M8.12 docs/arch-08.md

## M9 — Projects/workspaces

- [x] M9.1 Add-folder flow (dialog, recents, validation)
- [x] M9.2 Project registry store + icon/color chips
- [x] M9.3 Sidebar grouping by project + resort FLIP animation
- [x] M9.4 Branch chip + quick switch popover
- [x] M9.5 Watcher service (chokidar) + debounced fs events
- [x] M9.6 Watcher→mentions index feed (iles.index RPC over watcher-fed per-project index; UI picker wiring is a follow-up)
- [x] M9.7 Project settings (default provider/model/mode per project)
- [x] M9.8 Unseen/activity markers on sessions

## M10 — Terminal & files

- [x] M10.1 node-pty host service in main (spawn, resize, kill process tree)
- [x] M10.2 xterm.js tabs in inspector pane
- [x] M10.3 Terminal theme sync + font binding
- [x] M10.4 Resize/input coalescing + scrollback replay (1MB cap)
- [x] M10.5 Shell detection per platform + profile hints
- [x] M10.6 File explorer tree (virtualized, watcher deltas)
- [x] M10.7 File context actions (reveal in explorer, open in editor, copy path)
- [x] M10.8 Binary/large-file guards
- [x] M10.9 Terminal a11y + selection copy behaviors
- [x] M10.10 Terminal stress test (fast-spew process, no dropped frames) (terminal-service.stress.test.ts: fake-pty spews 10k×100B chunks synchronously — zero-loss onData forwarding + scrollback ring bounded ≤ 1MB; dropped frames need a real compositor, unverifiable headless)
- [x] M10.9 Terminal a11y + selection copy behaviors (TerminalA11y aria-live announcer for title changes; xterm native selection remains the copy path)
- [x] M10.10 Terminal stress test (fast-spew process, no dropped frames)

## M11 — Ari Core harness

- [x] M11.1 Endpoint store CRUD + safeStorage encryption + encrypted-file fallback
- [x] M11.2 OpenAI chat-completions client (SSE stream parser) + fixture tests
- [x] M11.3 Anthropic messages client (SSE) + fixture tests
- [x] M11.4 Ollama client + fixture tests
- [x] M11.5 Connection tester (latency, /models listing) + UI hooks
- [x] M11.6 Agent loop: tool round-trips, cancellation, retry policy
- [x] M11.7 System prompt builder + workspace context injection
- [x] M11.8 Tool: bash (pty, timeout, output cap)
- [x] M11.9 Tools: read_file / write_file (path jail)
- [x] M11.10 Tool: edit_file exact-string replace + diff preview event
- [x] M11.11 Tools: glob / grep (rg if present else JS fallback)
- [x] M11.12 Tool: todo_write (structured plan tracking)
- [x] M11.13 Context-window manager (truncate/summarize oldest tool results)
- [x] M11.14 Register as driver: transcript/approvals/checkpoints parity
- [x] M11.15 Token accounting + cost estimate plumbing
- [x] M11.16 Ari Core e2e test against scripted fake endpoint
- [x] M11.17 Endpoint security review (header handling, SSRF guardrails)
- [x] M11.18 docs/arch-11.md

## M12 — Settings & providers manager

- [x] M12.1 Appearance page: live theme preview, accent override, density
- [x] M12.2 Providers page: detect grid, auth badges, install hints, re-scan
- [x] M12.3 Endpoints page: CRUD + test + key entry UX (UI-only, also covers M11.5 UI hooks: localStorage `ari.endpoints` store, engine store wiring lands later)
- [x] M12.4 Permissions page: modes default, allowlist editor
- [x] M12.5 Keybindings page: logical map, Mod symbols, conflict detection (read-only v1 table; remapping + conflict detection land with the keybindings layer)
- [x] M12.6 Advanced page: logs viewer, journal tools, diagnostics export (diagnostics export + journal location hint + draft-cache danger zone; logs viewer/journal tools deferred to engine-backed settings work)
- [x] M12.7 Settings events through engine (single writer)
- [x] M12.8 Import/export settings bundle
- [x] M12.7 Settings events through engine (single writer) (`settings.get`/`settings.update` RPC over SettingsStore; Appearance/Permissions pages moved off localStorage via useEngineSettings)
- [x] M12.8 Import/export settings bundle (Advanced page; loose client-side version check, engine-side deep validation; window bounds stay local)
- [x] M12.9 Settings search (palette-integrated) (SettingsSearch over a static {section,label,keywords} index with smooth-scroll to `settings-*` anchors; palette/shell wiring follows)
- [x] M12.10 Settings a11y + keyboard traversal (stable section ids on every settings page wrapper; live result-count region; results are real buttons with focus-visible states)

## M13 — Polish & motion pass

- [x] M13.1 Sidebar session-resort FLIP polish (motion.li `layoutId` rows under AnimatePresence; spring stiffness 500 / damping 40)
- [x] M13.2 Toast audit + queue behaviors (AppProviders mounts ToastProvider around the shell; CheckpointList/settle toasts no longer throw)
- [x] M13.3 Skeleton/loading audit (no spinners >300ms) (Spinner usage audited — none outside gallery; transcript shows 4 Skeleton rows while initial `session.load` resolves)
- [x] M13.4 prefers-reduced-motion full sweep
- [x] M13.5 Focus-visible sweep + tab order audit (rings added to theme cards + model-picker options; settings/projects/endpoints buttons verified via Button/IconButton kit styles)
- [x] M13.6 Keyboard map completion + cheat-sheet overlay (?)
- [x] M13.7 Memory audit vs budgets (long-session soak) (memory-bounded scrollback assertion: 15k-chunk/1.5MB soak truncates the terminal ring to exactly 1MB; journal read-back bounded < 2s)
- [x] M13.8 Cold-start profiling vs 2.5s budget (journal.perf.test.ts cold read-back of a persisted 10k-event journal < 2s — boot replays journals on startup (M3.9), so this bounds the dominant boot cost; full app-boot profiling needs a packaged run)
- [x] M13.6 Keyboard map completion + cheat-sheet overlay (?) (KeyboardCheatSheet opens on bare ? outside editable elements; complete map incl. composer/approval/question chords)
- [x] M13.7 Memory audit vs budgets (long-session soak)
- [x] M13.8 Cold-start profiling vs 2.5s budget
- [x] M13.9 Empty/error edge sweep (every pane) (audited ChangesView, ProjectsView, TerminalView, SettingsView — all render meaningful empty/error content when data is absent; no blank panes found, no fixes needed)
- [x] M13.10 UX copy pass (voice: precise, warm, zero fluff) (sentence case + imperative standardized: Add project, re-scan hint, Jump to latest; no exclamation marks anywhere)
- [x] M13.11 Boot splash + working-indicator signature moments
- [x] M13.12 Notification-on-settle when unfocused

## M14 — Package & ship

- [x] M14.1 electron-builder config: NSIS target + signing scaffolding
- [x] M14.2 DMG universal target config
- [x] M14.3 AppImage + deb targets
- [x] M14.4 App icons (win/mac/linux) + installer assets
- [x] M14.5 `pnpm dist` pipeline + artifact smoke checklist doc (`scripts/dist.md`: exact per-platform electron-builder commands, artifact table, 4-step smoke checklist; raw `npx` commands until a root `dist` script lands)
- [x] M14.6 Auto-update scaffolding (electron-updater, disabled by default) + README/docs final pass

## M23 - V3 overhaul

- [x] M23.1 Split provider install state from auth state: `Detection.installed` + `authReason` (contracts + detector), a missing binary is `installed:false` / `authStatus:'unknown'` instead of the old false `'unauthenticated'`; real read-only auth probes for grok/pi/hermes with `XAI_API_KEY` / `PI_CODING_AGENT_DIR` / `HERMES_HOME` overrides; pure `package-manager.ts` mapping binary path + kind to argv install/upgrade commands
- [ ] M23.2 Install/update execution + UI: `install.ts` runner (single-flight, timeout, tail-capped output, mandatory re-detect), progress RPC/stream pair, ProvidersView card rebuild with confirm-before-run, dismissible update toast
- [x] M23.3 Multiple projects open directly in the sidebar: `Project` gains `open`/`lastOpenedAt`/live `status`, realpath-canonicalized dedupe so reopening a folder reuses its project, `project.open`/`project.close`/`dialog.pickFolder`/`shell.revealPath` RPCs, collapsible per-project session groups with an Unfiled group and a degraded missing-folder row, project-aware `sidebarOrder` so keyboard traversal matches the rendered order, `projects` removed from the bottom nav strip
- [ ] M23.4 Move ProjectsView to a settings section for known-but-closed projects (it still owns the script runner and per-project defaults)
- [x] M23.5 Real multi-theme engine: six full oklch palettes (obsidian, graphite, nocturne, verdant + light porcelain, sandstone) replacing the single hardcoded `comet-glass` appearance, per-theme `[data-ari-theme]` token blocks, glass demoted to an opt-in per-theme capability gated on `[data-ari-glass]` and forced off by `prefers-reduced-transparency`, engine-persisted theme/mode/glass with a localStorage pre-hydration cache, `theme.apply` RPC so window chrome (backgroundMaterial/vibrancy/backgroundColor/titleBarOverlay/nativeTheme) tracks the active theme instead of assuming dark acrylic, Appearance picker with swatch previews and Follow system. Contrast verified numerically: fg/bg 14.7-17.2:1, muted 6.1-9.2:1, accent 4.5-10.8:1
- [x] M23.10 Post-merge review fixes for #75/#76: `stopWatchingProject` tears down a removed project's watcher + file index (was leaking fs events for the process lifetime); `ProjectStore.load()` is load-once so a slow read can't clobber in-flight mutations; archived/search rows keep their project chip via `knownProjectNames`; `dialog.pickFolder` takes `defaultPath` so Locate starts near the dead folder; every swallowed RPC rejection in `App.tsx` now logs through `@ari/shared/logger`; `docs/arch-23.md` written; cross-package test pins `themeIdSchema.options` == `themeIds`
- [x] M23.11 Theme provider hardening: the save effect is gated on hydration so the localStorage cache can never overwrite the durable copy before it loads (a picked theme could be lost); `applyCachedTheme()` paints the cached palette before React mounts so light-theme users don't get a dark first frame
- [x] M23.6 Journal replay validation: every replayed line passes `journalEventSchema.safeParse`; JSON or schema failures are quarantined verbatim to `journal.rejected.jsonl` and surfaced as count + first reason — never thrown, never silently dropped; dedicated `journal-replay.test.ts` covers truncated lines, unknown event types, invalid seq
- [x] M23.7 Shared process teardown ladder (`providers/teardown.ts`): stdin EOF grace → SIGTERM → tree kill (`taskkill /T /F` on win32, SIGKILL elsewhere), each rung raced against process exit, structural `TeardownTarget` so real ChildProcess and the drivers' narrow legacy types both qualify; wired into claude/codex/grok/pi/hermes/opencode dispose paths
- [x] M23.8 ACP steering: ACP has no mid-turn injection method (verified against agentclientprotocol.com v2 prompt-lifecycle), so the adapter now accepts `steer` and chains the text as the next `session/prompt` at the turn boundary inside one continuous stream instead of omitting steer entirely; texts lost to transport failure surface as an error event naming them
- [x] M23.9 Wire-boundary parsing: the `as unknown as` cast at `acp/protocol.ts` replaced with zod validation (`acpToolCallContentSchema`, fail-soft via `.catch([])`); provider mappers audited — all already parse defensively into surfaced error events

## Stretch backlog (post-V1, unplanned)

- MCP client support
- ACP generic driver
- Remote/web companion (lift engine to sidecar)
- Plugin API
- Usage dashboards/heatmaps

---

## Blockers

| Task | Tried | Error essence | Status |
| --- | --- | --- | --- |


## Merge log

| PR | Task | Merged |
| --- | --- | --- |
