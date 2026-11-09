# Aria hold to talk

The native hook runs only while `settings.speech.enabled` is true and
`speech.status` reports ready. It observes key events without suppressing them,
including when Ari has focus. Dictation always goes to the shared Aria thread;
existing browser and OS actions for the chord still run.
macOS defaults to holding Right Option alone (`alt-right`). Recording starts on
press; the pill appears after 250 ms. A short tap or typing another key during
the hold cancels quietly, so Option character entry is unaffected.

The non-focusable renderer records while held. Releasing the chord stops and
transcribes; Esc while held cancels. Silence hides quietly. Only the current
hold can publish a result. Aria's normal command dispatcher starts or queues the
message through one `message.enqueue` command.

Modifier flags reconcile missed releases after the source first sets each flag;
unmasked injected modifiers use tracked keycodes. Lock and suspend reset input
tracking while preserving already released dictations. Renderer crashes recover
with a capped backoff. All main-window
reopen paths bind fresh RPC and widget services. Timers run only for an active
state deadline or while recording.

`uiohook-napi` 1.5.5 ships Node-API prebuilds. The builder uses those binaries,
unpacks the hook and its loader, and preserves both macOS architecture slices.
Windows was verified with Electron 43.4.1. macOS requires Accessibility permission;
Linux's hook uses X11. Platform checks remain necessary on macOS and Linux.

The recorder and missing speech RPC fallback are temporary integration stubs.
Replace the recorder with the speech worker's implementation; its real registered
RPC handlers automatically take precedence over the missing-method fallback.

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
