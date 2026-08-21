# arch-00 — Scaffold decisions

## Layout

- `apps/desktop` is an electron-vite app with `src/main`, `src/preload`, `src/renderer`.
  The renderer lives inside the desktop app per electron-vite convention; all UI code is
  imported from workspace packages (`@ari/ui`, …), keeping it portable to a future web app.
- Workspace packages export **TypeScript source** via narrow subpaths
  (`"@ari/shared/jsonl": "./src/jsonl.ts"`). No build step per package; Vite/rollup and
  vitest consume sources directly. `pnpm -r build` is reserved for packaging.

## Process & security

- Renderer: sandboxed, `contextIsolation: true`, no Node. Preload exposes a single
  allowlisted API object under `window.ari`.
- Sandboxed renderers require a **CommonJS preload**, so electron-vite emits
  `out/preload/index.cjs` (`format: 'cjs'` override) while the app stays ESM.
- CSP is set in `index.html` (`default-src 'self'`). External links are routed to the OS
  shell and denied in-window.

## Platform chrome

Windows uses `titleBarOverlay`; macOS `hiddenInset`; Linux gets custom controls in M2.
The strategy seam lives in `apps/desktop/src/main/window.ts`.

## Toolchain

- TypeScript pinned to ^5 (the 7.x Go compiler line is too new for the typed-eslint
  toolchain the fleet relies on; revisit later).
- ESLint flat config with `recommendedTypeChecked` + `projectService`; plain JS files
  (config itself) get `disableTypeChecked`.
- pnpm `onlyBuiltDependencies`: `electron`, `esbuild`. Note: if electron's binary download
  is skipped on a fresh clone, run its `install.js` once or `pnpm rebuild electron`.
- `pnpm verify` = typecheck + lint + test across all packages; required green before every
  commit (AGENTS.md).

## Verified

- `pnpm verify` green (21 tests).
- `electron-vite build` produces main/preload/renderer bundles.
- `pnpm dev` boots the window; renderer↔main bridge proven via `ari:ping`.
