# Aria hold to talk

The native hook runs only while `settings.speech.enabled` is true and
`speech.status` reports ready. It observes key events without suppressing them,
including when Ari has focus. The Aria binding goes to the shared Aria thread;
existing browser and OS actions for the chord still run.
Windows and Linux default to `ctrl+alt+space`; macOS defaults to
`shift+meta+space`. Settings lets the user record a different shortcut. The widget
accepts a modifier chord with one supported key, or a function key alone, and
refuses reserved OS shortcuts. Modifier-only and side-specific shortcuts are
not supported.

Settings also exposes a separate general dictation binding: `ctrl+alt+d` on
Windows/Linux and `shift+meta+d` on macOS. It inserts into the captured focused
text field without sending. External fields currently use Windows UI Automation
and Unicode input; other platforms support Ari text fields only. The widget and
session microphone share capture ownership. See
[dictation routing](../../../../../docs/research/dictation-routing.md) for migration,
target guards, native verification evidence, and platform limits.

The non-focusable renderer records while held. Releasing the chord stops and
transcribes; Esc while held cancels. A new hold replaces a sent or error pill;
presses during transcription or sending are ignored. Silence hides quietly. Only the current
hold can publish a result. Aria's normal command dispatcher starts or queues the
message through one `message.enqueue` command.

Modifier flags reconcile missed releases after the source first sets each flag;
unmasked injected modifiers use tracked keycodes. Lock and suspend reset input
tracking while preserving already released Aria dictation; general dictation is
cancelled to protect its focused target. After a reset, the
shortcut key must be released or stay quiet for one second before another hold.
Renderer crashes recover
with a capped backoff. All main-window
reopen paths bind fresh RPC and widget services. Recording lasts until release or
cancellation; listening and transcription have no widget deadline. The speech
service applies an audio/model-aware failure budget after inference starts,
without charging queued requests for their wait. Sent and error pills still
expire, and the renderer meters audio only while recording.

`uiohook-napi` 1.5.5 ships Node-API prebuilds. The builder uses those binaries,
unpacks the hook and its loader, and preserves both macOS architecture slices.
Windows was verified with Electron 43.4.1. macOS requires Accessibility permission;
Linux's hook uses X11. Platform checks remain necessary on macOS and Linux.

The production recorder uses a microphone stream and AudioWorklet; transcription
runs in the native speech worker. General dictation never uses the Aria handoff
as an error fallback.

Both global shortcuts share the optional audio-ducking path. Only current-hold
first samples lower other apps, and stopping capture restores audio before
transcription. Composer microphones keep their existing output behavior. See
[combined speech compatibility](../../../../../docs/research/speech-compatibility.md)
for joint headless verification and limitations. Previous Windows native checks
do not verify the combined compatibility head.

After a desktop build, run the screenshot and native background checks from
`apps/desktop`:

```powershell
pnpm exec vite build --ssr src/main/aria-widget/capture.e2e.ts --outDir out/e2e --emptyOutDir
pnpm exec electron --no-sandbox out/e2e/capture.e2e.js
```

Screenshots default to `D:\tmp\aria-widget-shots`; `ARIA_WIDGET_SHOTS` changes the
destination. `packaged.e2e.ts` checks the actual asar unpack mapping after a Windows
directory build; `ARIA_WIDGET_PACKAGE` defaults to
`D:\tmp\aria-widget-package\win-unpacked`.
