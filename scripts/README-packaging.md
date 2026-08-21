# Packaging Ari desktop

How to build distributable installers for Windows, macOS, and Linux. Config lives in
`apps/desktop/electron-builder.yml` (M14.1–M14.3).

## Prerequisites

- Node >= 22 and pnpm; workspace installed (`pnpm install`).
- **node-pty native rebuild**: node-pty is the only native dependency and must be compiled
  against Electron's ABI (not the system Node). After every `pnpm install` or Electron
  version bump, run from `apps/desktop`:

  ```sh
  npx electron-builder install-app-deps
  ```

  If pnpm blocked the postinstall script (`Ignored build scripts: node-pty`), approve it
  once via `pnpm approve-builds` first.
- Renderer/main bundles must exist before packaging:

  ```sh
  pnpm --filter @ari/desktop build
  ```

## Build commands (run from `apps/desktop`)

```sh
npx electron-builder --win     # NSIS installer
npx electron-builder --mac     # universal DMG (x64 + arm64 merged)
npx electron-builder --linux   # AppImage + deb
```

Notes:

- There is intentionally no root/package script for this yet — the `pnpm dist` pipeline is
  task M14.5 (orchestrator-owned manifests). Use the raw `npx` commands above.
- macOS builds only run on macOS (Xcode toolchain required); cross-building from Windows/
  Linux is not supported by electron-builder.
- The deb target requires `fakeroot`/`dpkg` tooling present on the build host.

## Artifacts

All artifacts land in the repo-root `dist/` directory (`directories.output: ../../dist`
relative to `apps/desktop`):

| Platform | File |
| --- | --- |
| Windows | `dist/Ari-Setup-<version>.exe` |
| macOS | `dist/Ari-<version>-universal.dmg` |
| Linux | `dist/Ari-<version>.AppImage`, `dist/ari_<version>_amd64.deb` |

Auto-update publishing is disabled (`publish: null`) until M14.6 wires electron-updater,
opt-in.

## Artifact smoke checklist

Run through this on a clean machine (or VM) per platform before shipping an artifact:

1. **Installer launches** — setup wizard runs; install directory can be changed (NSIS);
   app installs without missing-dependency errors.
2. **Window opens** — app starts from the installed shortcut (not dev mode); window
   chrome renders for the platform; no blank screen / console errors on boot.
3. **Terminal pane spawns shell** — open the inspector terminal tab; a real shell prompt
   appears (ConPTY on Windows, login shell on mac/Linux). This proves the unpacked
   node-pty native module loads correctly.
4. **Session turn runs against a configured provider** — add a provider endpoint in
   settings (or use a detected CLI), send a message in a session, and confirm streamed
   output renders and the turn settles without errors.

Any failure in step 3 almost always means node-pty ended up inside asar instead of
unpacked, or was rebuilt for the wrong ABI — re-run `install-app-deps` and repackage.
