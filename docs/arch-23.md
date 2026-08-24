# M23 — V3 overhaul architecture notes

Covers the three merged waves: provider state split (#74), sidebar projects
(#75), and the theme engine (#76), plus their review follow-ups.

## Provider detection: two axes, never one

`Detection` carries `installed: boolean` (binary resolved on PATH / known
location) separately from `authStatus`. A missing binary is
`installed: false` + `authStatus: 'unknown'` + an `authReason` — it is never
reported as `unauthenticated`, which previously made working providers look
broken. Auth probes are read-only existence checks; no credential file is ever
read, written, or logged.

`package-manager.ts` maps a resolved binary path to the manager that owns it
and emits install/upgrade commands as argv arrays. The install/update runner
that consumes it is deferred (M23.2).

## Projects live in the sidebar

The project list moved from a bottom-strip destination to first-class sidebar
groups. Key invariants:

- **Identity**: uuid ids (`proj_*`); paths are canonicalized with realpath plus
  a win32 case fold before dedupe, so one folder can never yield two projects.
- **Lifecycle**: `open` (in the sidebar) vs `close` (hidden but kept) vs
  `remove` (destructive, confirms). `remove` also stops the project's
  `WorkspaceWatcher` and drops its file index.
- **Status**: `status: 'ok' | 'missing'` is computed at read time from the
  filesystem and never persisted, so a remounted folder recovers without user
  action.
- **Store concurrency**: `ProjectStore.load()` is load-once; later calls return
  the in-memory list so a slow disk read can never clobber an in-flight
  mutation.
- **Keyboard parity**: `sidebarOrder()` walks exactly the groups the sidebar
  renders (project groups → Unfiled → nothing archived), so Mod+1..9 and
  Ctrl+Tab always match what the user sees.

New RPC surface: `project.open`, `project.close`, `project.remove`,
`dialog.pickFolder` (optional `defaultPath` for Locate),
`shell.revealPath`.

## Theme engine

Six full oklch palettes defined once in `packages/ui/src/themes.ts`;
`tokens.css` mirrors them per `[data-ari-theme='<id>']` block and
`themes.test.ts` asserts the mirror can't drift. `:root` doubles as obsidian so
pre-hydration HTML paints correctly. Glass is a per-theme capability gated on
`[data-ari-glass]`; `prefers-reduced-transparency` wins over any opt-in.

The theme id union exists twice by design — `@ari/contracts/settings.ts`
(zod) and `@ari/ui/themes.ts` (runtime) — because contracts must stay
UI-free. Nothing else links them, so `window.test.ts` asserts the two lists
are equal.

Window chrome (background material, background color, title-bar overlay,
nativeTheme) derives from the active theme via the `theme.apply` RPC instead of
assuming dark acrylic.
