# `pnpm dist` pipeline & artifact smoke checklist (M14.5)

Exact commands to produce every distributable target. Config lives in
`apps/desktop/electron-builder.yml`; deeper context in
[`README-packaging.md`](./README-packaging.md).

## Prerequisites (every build)

```sh
pnpm install                                # workspace deps
npx electron-builder install-app-deps       # run from apps/desktop; rebuilds node-pty for Electron's ABI
pnpm --filter @ari/desktop build            # electron-vite build → apps/desktop/out/
```

If pnpm reports `Ignored build scripts: node-pty`, approve it once first:
`pnpm approve-builds`.

## Platform targets

Run from `apps/desktop`:

```sh
# Windows — NSIS installer
npx electron-builder --win

# macOS — universal DMG (x64 + arm64 merged)
npx electron-builder --mac

# Linux — AppImage + deb
npx electron-builder --linux

# All targets the current host can build
npx electron-builder -mwl
```

Host constraints: macOS builds require a macOS host (Xcode toolchain); the deb
target requires `fakeroot`/`dpkg` on the Linux build host. Windows and AppImage
can be built from any host.

## Artifacts

Everything lands in repo-root `dist/` (`directories.output: ../../dist`):

| Platform | File |
| --- | --- |
| Windows | `dist/Ari-Setup-<version>.exe` |
| macOS | `dist/Ari-<version>-universal.dmg` |
| Linux | `dist/Ari-<version>.AppImage`, `dist/ari_<version>_amd64.deb` |

Auto-update publishing stays disabled (`publish: null`) until electron-updater
is wired opt-in.

## Smoke checklist (per artifact, on a clean machine or VM)

1. **Installer launches** — setup wizard runs; install directory can be changed
   (NSIS); installs without missing-dependency errors.
2. **Window opens** — launch from the installed shortcut (not dev mode);
   platform chrome renders; no blank screen or console errors on boot.
3. **Terminal pane spawns a shell** — open the terminal tab; a real prompt
   appears (ConPTY on Windows, login shell on mac/Linux). This proves the
   unpacked node-pty native module loads inside asar.
4. **A session turn completes** — with a detected CLI or configured endpoint,
   send a message and confirm streamed output renders and the turn settles.

Step 3 failing almost always means node-pty ended up packed in asar or was
rebuilt for the wrong ABI — re-run `install-app-deps`, rebuild, repackage.
