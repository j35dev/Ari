# Aria recording audio attenuation

## Handy evidence

Inspected the public canonical [cjpais/Handy repository](https://github.com/cjpais/Handy), whose README identifies the offline desktop app and links handy.computer. The source checkout was pinned to commit **73cc8579cff74e97e08de9d86035a92e4335ff7f**, inspected on 2026-11-10.

- [src-tauri/src/managers/audio.rs](https://github.com/cjpais/Handy/blob/73cc8579cff74e97e08de9d86035a92e4335ff7f/src-tauri/src/managers/audio.rs#L25): `set_mute` changes the system output mute state. Windows uses `IMMDeviceEnumerator`, the default render endpoint and `IAudioEndpointVolume::SetMute`; Linux tries `wpctl`, then `pactl`, then `amixer`; macOS uses `osascript`. `get_mute` reads the corresponding prior state.
- [The same file, microphone lifecycle](https://github.com/cjpais/Handy/blob/73cc8579cff74e97e08de9d86035a92e4335ff7f/src-tauri/src/managers/audio.rs#L760): `apply_mute` checks the setting and open stream and avoids re-snapshotting its own mute. `remove_mute` restores the prior state. Microphone stream teardown also restores audio, including line 923 onward.
- [src-tauri/src/actions.rs](https://github.com/cjpais/Handy/blob/73cc8579cff74e97e08de9d86035a92e4335ff7f/src-tauri/src/actions.rs#L603): checks the current readiness generation after real input callbacks before applying mute; on stop it removes mute before transcription/feedback at line 687.
- [src-tauri/src/settings.rs](https://github.com/cjpais/Handy/blob/73cc8579cff74e97e08de9d86035a92e4335ff7f/src-tauri/src/settings.rs#L498): `mute_while_recording`, default false at line 1044.
- [LICENSE](https://github.com/cjpais/Handy/blob/73cc8579cff74e97e08de9d86035a92e4335ff7f/LICENSE): MIT, copyright 2025 CJ Pais. Ari's implementation is original TypeScript; no Handy source code was copied.

Handy's inspected implementation **mutes output**. It does not implement per-application volume ducking. Ari borrows the readiness, ownership, prior-state and teardown principles, while implementing the requested attenuation instead.

## Ari behavior and coverage

The shortcut widget reports its first real microphone samples and capture cleanup through a sender-checked, current-hold IPC method. Audio is lowered only while that hold is listening; release, Escape, input reset, capture failure, speech disable, widget close/crash and quit remove its ownership. Settings → Speech to text includes **Lower other apps while listening**, enabled by default on supported hosts. Opt-out restores audio without interrupting the microphone. Composer dictation is unaffected.

One helper and one baseline serve overlapping widget owners. Playback levels are reduced to **25% of their prior level**. Each channel is retained, zero volume stays zero, and mute, microphone gain and endpoint/master volume are never written. If a user changes an application's volume during capture, that choice is preserved instead of restoring a stale level.

Windows uses per-session `ISimpleAudioVolume` on render endpoints, stable session instance identifiers, COM reference cleanup and Ari process IDs from Electron app metrics. Relevant SDK documentation consulted: [IAudioSessionControl2](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nn-audiopolicy-iaudiosessioncontrol2). Koffi 3.0.2's installed `doc/functions.md`, `doc/output.md` and `index.d.ts` were consulted for calling conventions, function pointers and output parameters. Existing packaging already unpacks Koffi and its platform binaries.

Linux uses `pactl` JSON sink-input inventories, server cookies and stream/process identities, preserves channel balance, and handles native integer-volume rounding. This covers PulseAudio and PipeWire's PulseAudio compatibility server when `pactl` is installed. ALSA-only systems and missing/unsupported tools leave audio unchanged. macOS leaves output unchanged and displays an unavailable setting because Handy's global AppleScript output control does not provide per-app control or preserve the system slider.

The helper scans playback streams during capture to include new apps, journals original/applied levels before writes, restores on IPC disconnect or shutdown signals, and recovers a previous helper's journal at app startup and before new attenuation. Poll requests are coalesced so a slow audio service cannot create a recording-length backlog. Unavailable devices retain restoration records for retry; explicit volume changes are respected during recovery. Abrupt termination of every process, persistent audio-service failure, hardware disappearance or an audio-server restart that recreates streams can prevent immediate restoration. Stable identities prevent restoring stale records onto unrelated new streams; the journal remains local under `userData/speech`.

Windows x64 native enumeration and a silent test stream were exercised with Node 24.13.0/Koffi 3.0.2: **0.60 → 0.15 → 0.60**, including duplicate activation. The built, unpackaged Electron helper also loaded the native backend and exited cleanly on parent IPC disconnect while inactive. Unit/integration tests cover readiness and stale callbacks, lifecycle restoration, overlapping owners, durable recovery, parent disconnect/signals, user changes, newly opened/closed streams, incomplete inventories, spawn failures, bounded retries, coalescing and Linux channel rounding. Real Linux playback, physical microphone dictation and packaged Electron execution have not been verified.

Run the Windows native smoke check from `apps/desktop`:

```powershell
pnpm exec vite build --ssr src/main/speech/audio-ducking.e2e.ts --outDir out/audio-e2e --emptyOutDir
node out/audio-e2e/audio-ducking.e2e.js
```
