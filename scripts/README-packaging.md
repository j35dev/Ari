# Packaging Ari desktop

How to build distributable installers for Windows, macOS, and Linux. Config lives in
`apps/desktop/electron-builder.yml` (M14.1–M14.3).

## Prerequisites

- Node >= 22 and pnpm; workspace installed (`pnpm install`).
- **node-pty ships prebuilt** — no ABI rebuild is needed. `@lydell/node-pty` is only a
  resolver stub that `require`s `@lydell/node-pty-<platform>-<arch>`, and that sibling
  package holds the implementation plus the prebuilt binaries (`conpty.node` /
  `pty.node`, and on Windows `conpty.dll` + `OpenConsole.exe`).

  Those platform packages are declared as explicit `optionalDependencies` of
  `apps/desktop`. **Do not remove them.** They are reachable as transitive optional deps
  too, but electron-builder only collects them reliably when they are direct: pnpm's
  virtual store keeps transitive optional packages out of
  `apps/desktop/node_modules/@lydell/`, and if electron-builder picks its npm collector
  (it mis-detects the workspace on Windows) they are dropped from the package entirely.
  pnpm links only the packages matching the current platform, so the extra entries cost
  nothing per build.

  `build/after-pack.cjs` asserts after every pack that the target's platform package was
  collected and unpacked; the build fails loudly rather than shipping a terminal that
  opens to a dead cursor.
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

Any failure in step 3 means the pty backend did not load. The terminal now names the
reason in the pane (with a retry), and `resources/app.asar.unpacked/node_modules/@lydell/`
must contain both `node-pty` and `node-pty-<platform>-<arch>` with its prebuilds — see the
node-pty note under Prerequisites.
