# Ari V3 Overhaul — plan of record

Date: 2026-08-24. Baseline: `main` @ 6f35ddd, 367 TS files, 152 test files, `pnpm verify` = typecheck + lint + test.

## Evidence (what is actually true today)

- **Theme engine was deleted, not built.** `packages/ui/src/theme-provider.tsx:9` hardcodes `APPEARANCE = 'comet-glass'`; `readStoredAppearance()` can only return that constant. `packages/ui/src/tokens.css` has one `:root` block, explicitly "sampled from comet's theme.rs". PROGRESS.md:57 claims "6 themes" — false.
- **Projects are not in the sidebar.** `shell/Sidebar.tsx:546` puts `projects` in the bottom `SIDEBAR_NAV` icon strip; selecting it opens `ProjectsView` in the *right inspector* (`App.tsx:435`). Session grouping is Pinned/Active/Earlier/Archived (`Sidebar.tsx:433-500`); project names are a per-row chip only (`Sidebar.tsx:364`).
- **No router.** `App.tsx:46-56` switches views with `useState` booleans. PLAN §1 claims TanStack Router; absent from the tree.
- **grok / pi / hermes auth detection unimplemented.** `packages/providers/src/detector.ts:149-151` returns `'unknown'` by default → the badge the user sees as "unauthenticated / error".
- **`detectDriver` conflates missing binary with bad auth.** `detector.ts:164` returns `authStatus: 'unauthenticated'` when `binaryPath === null`. Wrong axis: not-installed is not an auth failure.
- **No install path.** `updates.ts` knows npm packages for claude/codex/opencode/pi and can compute `updateAvailable`, but nothing installs or updates anything, and no toast surfaces it. `ProvidersView.tsx` renders detection read-only (128 lines, no actions).
- **Journal replay bypasses zod.** `engine/src/session-store.ts` folds raw disk JSON into `applyEvent` with no `journalEventSchema.safeParse`. Provider mappers cast `JSON.parse` directly (`claude/mapper.ts`, `acp/protocol.ts:142` has `as unknown as`).
- **ACP has no `steer`.** `acp/acp-driver.ts` adapter omits it, so mid-turn steering silently degrades to queueing on the ACP path; ACP→legacy fallback only `log.warn`s.

## Reference takeaways

- **zeronsh/comet** is Rust + forked GPUI, *not* Electron. Its glass depends on that fork and **Windows transparency is deliberately unsupported** (`GLASS_ALPHA = 1.0` on Windows, `is_frost()` excludes win32). Confirms the user's instinct. Portable as *spec*: oklch semantic token struct, hand-rolled diff row model (flat file/hunk/line rows, virtualized at line granularity, unified↔split as a re-flatten), motion catalog with exact curves, splash with 150ms hold + 6px lift, shared 30fps pulse clock (per-frame repeats burned 36% CPU at 120Hz).
- **pingdotgg/t3code** is the closest architectural sibling. Copy: `THEME_COLOR_ROLES` (~55 semantic roles) × light/dark variants × 5 built-in themes + user theme files; package-manager inference from the resolved binary path (`isNpmGlobalCommandPath`, homebrew Cellar, bun/pnpm global) → concrete upgrade command; `providerMaintenanceRunner` with 5-min timeout, 10KB output cap, kill finalizer, then re-probe to verify; persistent stacked update toast with dismissal keys and a 30s settling grace.
- **deepseek-harness-desktop**: workspace id is a uuid, never the path; `path` canonicalized via realpath; `status(): 'ok' | 'missing-dir'`; drag-and-drop folder adoption; transactional install with WAL receipts + rollback. Its agent teardown ladder (stdin EOF grace → SIGTERM → SIGKILL → tree join) is worth copying.

## Decisions taken (user cancelled the question round; these are the defaults I ship)

1. **Six themes, each a full palette, none named "comet".** Light: **Porcelain** (off-white + violet accent — the user's request), **Sandstone** (warm paper + teal). Dark: **Obsidian** (current near-black + indigo, retained as default), **Graphite** (neutral + amber), **Nocturne** (deep indigo + cyan), **Verdant** (dark moss + lime).
2. **Glass becomes a per-theme capability, not the design.** Opaque surfaces are the substrate; acrylic/vibrancy is opt-in and off by default on Windows.
3. **Install runs on explicit confirm**, showing the exact command and streaming output. No silent mutation of the user's machine.
4. **Worktree + PR per wave**, sequenced so no two in-flight waves share a file. Another agent may be in `packages/ui` components — waves avoid existing component files.

## Waves

Each wave = one worktree under `../ari-wt/<wave>`, branch `feat/v3-<wave>`, own PR, `pnpm verify` green, PROGRESS.md ticked, worktree removed after merge.

### Wave 1 — theme engine (`feat/v3-themes`)
Files: `packages/ui/src/{tokens.css,theme-provider.tsx,glass.css,themes.ts}`, `features/settings/AppearanceSettings.tsx`, `apps/desktop/src/main/window.ts`, `packages/contracts/src/settings.ts`.
- `themes.ts`: `ThemeId` union, `THEME_ROLES` list, one record per theme, all oklch. Tokens.css becomes `[data-ari-theme="<id>"]` blocks generated from that record — still the only file with color literals (AGENTS.md).
- `ThemeProvider`: real state, `theme.set` through engine settings (persisted, not localStorage), `follow system` mode via `nativeTheme`, `prefers-reduced-motion` + `prefers-reduced-transparency` respected.
- Window: `backgroundMaterial`/`vibrancy` become conditional on the active theme's `glass` flag; default opaque `backgroundColor` from theme `bg`; titleBarOverlay color syncs on theme change (Windows repaint quirk).
- Tests: every theme defines every role; contrast floor assertion for fg-on-bg; provider swaps `data-ari-theme`.

### Wave 2 — sidebar projects (`feat/v3-sidebar-projects`)
Files: `shell/Sidebar.tsx`, `App.tsx`, `features/projects/*`, `packages/engine/src/projects.ts`, `contracts/src/rpc.ts`.
- Sidebar body becomes: **Open project** button → native folder picker; then one collapsible group per open project, sessions nested inside, ad-hoc sessions in an "Unfiled" group. Remove `projects` from the bottom strip.
- Project model gains `lastOpenedAt`, `status: 'ok' | 'missing'` (realpath check, per deepseek), and open/close (close ≠ delete). Canonicalize paths; uuid ids stay.
- Per-project row: branch chip, session count, context menu (reveal, close, remove).
- Tests: grouping, missing-folder state, close/reopen round-trip, no-projects empty state.

### Wave 3 — provider lifecycle (`feat/v3-providers`)
Files: `packages/providers/src/{detector.ts,updates.ts,install.ts,package-manager.ts}`, `features/providers/ProvidersView.tsx`, main RPC.
- Split the axes: `installed: boolean` distinct from `authStatus`. Never report "unauthenticated" for a missing binary.
- Real auth probes for grok/pi/hermes (config paths verified empirically, fail-soft to `unknown` with an honest tooltip).
- `package-manager.ts`: infer npm/pnpm/bun/brew from the resolved binary path (t3code recipe) → exact install and upgrade commands.
- `install.ts`: run one operation at a time per kind, 5-min timeout, output cap, kill finalizer, re-probe to verify, stream progress over RPC.
- `ProvidersView`: per-provider state card — installed/not, auth, version vs latest, Install / Update / Re-check buttons, confirm dialog showing the literal command, live output pane.
- Update toast: persistent, dismissible per version, 30s grace after launch.
- Tests: fixture-driven path→manager inference, command construction, timeout/kill, verify-after-install.

### Wave 4 — protocol hardening (`feat/v3-protocol`)
- `journalEventSchema.safeParse` on replay; unparseable lines quarantined to `journal.rejected.jsonl` with a surfaced diagnostic, never a throw.
- zod at every provider wire boundary; mapper drift produces the diagnostic card PLAN §4.2 promised.
- ACP: implement `steer`, surface fallback as a session event, remove the `as unknown as` cast.
- Teardown ladder for child processes (EOF → SIGTERM → SIGKILL → tree).

### Wave 5 — diff viewer + transcript diff cards (`feat/v3-diffs`)
Flat row model (file header / hunk header / line / notice), line-granularity virtualization, unified↔split as pure re-flatten, fold tween, hunk nav, revert-hunk. Diff cards inline in the transcript.

### Wave 6 — branding + motion (`feat/v3-branding`)
Wordmark (ARI, Latin *arius*), boot splash with 150ms hold + lift-out, shared 30fps pulse clock, motion catalog as tokens, reduced-motion honored. Theme-aware.

### Wave 6b — theme scenery (`feat/v3-scenery`)
User request: themes carry artwork, not just palettes. Design constraint — a wallpaper must never cost legibility, so it renders *behind* a per-theme scrim and only in low-density regions (sidebar backdrop, empty transcript state, splash), never behind body text or diffs.

- `scenery` becomes an optional field on each theme: `{ asset, focal, scrimOpacity }`. A theme without one looks exactly as it does today.
- Ship 4–6 bundled assets, locally stored (no network, no CSP hole): two abstract-gradient, two nature (dawn ridge, deep forest), one anime-styled cityscape at dusk, one starfield. Only assets we can license cleanly — **I must not ship art of uncertain provenance**, so these are generated/CC0 and the source is recorded in `docs/`.
- "Custom wallpaper…" picks a local image, copied into app data, downscaled, EXIF stripped.
- Off by default per theme; a single Appearance toggle kills all scenery. `prefers-reduced-transparency` and low-power/battery states force it off.
- Perf gate: static image, no per-frame work, decoded once; must not regress the 30fps pulse-clock budget.


### Wave 7 — skills + endpoint harness depth (`feat/v3-skills`)
Skill files discovered per project, listed and injectable; harness tool-loop hardening.

## Order and gates

1, 2, 3 in parallel (disjoint files). 4 after 3. 5, 6 after 1. 6b after 6. 7 last. `pnpm verify` on `main` after every merge batch.

## Log

- **PR #74 merged** — providers: `installed` split from `authStatus`, real grok/pi/hermes probes, `package-manager.ts`. Verify green (489 tests).
- Another agent landed `67866d4 feat(ui): agent-first composer and model picker` on main; waves 1 and 2 rebase onto it before merge.
- **PR #75 merged** (`700df66`) — sidebar multi-project. Verify EXIT=0. Review found no spec gaps; follow-ups filed below.
- **PR #76 merged** (`1b537b6`) — six-theme engine. Verify EXIT=0 after rebase onto #75. Obsidian's 36 color tokens confirmed byte-identical to the old `:root`; `themes.test.ts` pins tokens.css against the registry so they cannot drift.
- PROGRESS.md section renumbered M16 → **M23**; M16 was already taken by the provider-rework milestone.
- **PR #77 merged** (`3081403`) — all six #75 review follow-ups: watcher teardown, load-once store, project chips, picker defaultPath, RPC error logging, arch-23 doc.
- **PR #78 merged** (`58b4318`) — wave 4 protocol hardening completed from the `0021d50` WIP: journal replay validation with quarantine, shared process-teardown ladder wired into six drivers, ACP steering via turn-boundary prompt chaining (ACP v2 has no mid-turn injection — verified against the spec), the last `as unknown as` wire cast replaced with zod.

- **PR #79 merged** (`349a897`) — M23.2 complete: `install.ts` runner, plan/install/cancel RPCs with settle-reflects-re-detect semantics, ProvidersView Install/Update/Cancel behind a confirm dialog showing the literal command, live output panes, update toasts after 30s grace. Also fixed the M18.2 title-upgrade test race.

- **PR #80 merged** (`c915352`) — user-reported batch: session replay dedupe (the doubled transcript after returning from Settings mid-turn), provider-first two-step model picker, Ctrl+K chip removed, labeled sidebar footer, sidebar collapse (Ctrl+B), Usage/Changes as full pages, ccusage report on the usage page. Shipped as one commit — the four fixes share contracts/rpc.ts + main/rpc.ts and splitting would have created non-compiling intermediates.

## Next session — start here

Waves 1-4, the #75 review follow-ups, M23.2, and the #80 user-reported batch are all merged; `main` is at `c915352`, local and origin in sync, **no worktrees remain** (a stale `.ari-wt/install-ui` folder may linger until a Windows file handle releases — git has already forgotten it).

Remaining, in recommended order:

1. **Wave 5 — diff viewer** (`feat/v3-diffs`): flat row model, line-granularity virtualization, unified↔split as pure re-flatten, fold tween, hunk nav, revert-hunk, transcript diff cards.
2. **M23.4 — move ProjectsView into a settings section** for known-but-closed projects; it still owns the script runner (`scripts.list`) and per-project defaults (`useProjectSettings.ts`).
3. **Wave 6 — branding/motion** (`feat/v3-branding`): ARI wordmark (*arius*, "heir"), boot splash (150ms hold + lift-out), shared 30fps pulse clock (never per-frame repeats — comet burned 36% CPU at 120Hz that way), motion catalog tokens, reduced-motion honored.
4. **Wave 6b — theme scenery** (`feat/v3-scenery`): the user's wallpaper request. CC0/generated assets only, provenance recorded in docs/, never behind body text or diffs, forced off under `prefers-reduced-transparency`.
5. **Wave 7 — skills + harness depth** (`feat/v3-skills`).

## Process notes (learned the hard way)

- Worker agents time out around the 20-minute mark. Brief them with every verified fact up front, order the work by value, and tell them to commit + push + open the PR the moment verify is green rather than at the end. Three agents lost a full session each to investigation before this was enforced.
- A new RPC needs THREE edits: `rpcParams` + `RpcResults` in `packages/contracts/src/rpc.ts`, `r.register` in `apps/desktop/src/main/rpc.ts`, and the hand-maintained `methods` allowlist array near `main/rpc.ts:720`. Omitting the allowlist yields a silent no-op. (`git.createPr`, `plan.get`, `scripts.list` are currently registered but missing from it — pre-existing, untouched.)
- `EndpointsManager.test.tsx` and one `engine.test.ts` case are timeout-flaky under full-suite load and pass in isolation. Confirm a failure in isolation before chasing it.
- Worktrees must live inside `D:/Projects/Ari` (`.ari-wt/`, git-ignored); writes outside the project root are blocked.