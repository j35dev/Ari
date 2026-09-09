# Bundled Cliamp (Focus music backend)

Cliamp (`bjarneo/cliamp`, MIT — see `LICENSE.cliamp`) is an **internal Ari
dependency**, not a user prerequisite. Ari ships the binary inside its own
installer; users never install, configure, or hear about it.

## Layout

```
resources/cliamp/
  cliamp.json       pinned version + per-target assets/checksums (source of truth)
  media-tools.json  pinned yt-dlp + ffmpeg (YouTube playback)
  LICENSE.cliamp    upstream MIT text
  LICENSE.yt-dlp    Unlicense
  LICENSE.ffmpeg    GPL notice for the bundled ffmpeg executable
  README.md         this file
  bin/<target>/     fetched binaries — gitignored (cliamp + yt-dlp + ffmpeg)
```

`<target>` is `<platform>-<arch>`: `win32-x64`, `linux-x64`, or
`linux-arm64`. The Windows zip's codec DLLs extract into the same folder — the
exe must never be separated from them. macOS is omitted until upstream ships a
self-contained binary.

`electron-builder.yml` copies `resources/cliamp` to `<resources>/cliamp`,
so the packaged layout mirrors development (`bin/<target>/` in both).
Resolution, daemon lifecycle, and the `--version` pin check all live in
`src/main/focus-music.ts`; the UI only sees `MusicService`.

## Upgrading

1. Bump `version` in `cliamp.json`; paste the new `sha256` values from the
   release's `checksums.txt` (verify over HTTPS from the release page).
2. `node scripts/fetch-cliamp.mjs --all --force`
3. `pnpm verify`, then build each installer and confirm music plays.
4. Never pull `latest` implicitly — upgrades are deliberate commits.

`prebuild` runs the fetch automatically, and `packaging/after-pack.js`
fails the build when the current target's binary is missing, not
executable, or reports a different `--version` than the pin.

## Runtime dependency audit (v2.2.0, verified against the real binaries)

| Target                        | Status                                                                                                                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `win32-x64`                   | Fully bundled: the release zip carries the exe plus its 6 codec DLLs.                                                                                                                                                                                                               |
| `linux-x64` / `linux-arm64`   | Fully bundled: release binaries statically link FLAC/Vorbis/Ogg/mpg123. Systems on PipeWire/PulseAudio still need their distro ALSA bridge (`pipewire-alsa` / `libasound2-plugins`) — a sound-server concern that cannot be bundled; playback failure degrades to MusicUnavailable. |
| `darwin-x64` / `darwin-arm64` | Upstream binaries dynamically link Homebrew `flac`, `libvorbis`, `libogg`, and `mpg123`, so Ari does not bundle them. The pill degrades to MusicUnavailable until upstream ships self-contained macOS builds.                                                                       |
| `win32-arm64`                 | No upstream asset exists. Ari never bundles it; the pill degrades to MusicUnavailable there by design.                                                                                                                                                                              |

Optional upstream runtimes Ari deliberately does **not** bundle in V1:

- YouTube song/playlist URLs now ship `yt-dlp` + `ffmpeg` next to Cliamp
  (see `media-tools.json`). SoundCloud/Mixcloud/etc. are still not advertised.

Network note: radio/podcast search and streams need internet like any
streaming feature; offline machines keep the timer and local files.

## Signing

The bundled binary is third-party code inside Ari's package:

- **macOS:** no Cliamp binary is currently bundled. A future self-contained
  upstream binary must be covered by Ari's signing/notarization; an unsigned
  sidecar will not survive Gatekeeper.
- **Windows:** ships inside the signed installer; no extra handling.
- **Linux:** no signing model; the fetch script restores the executable bit
  (`chmod 755`) that zips/tarballs do not always preserve.
