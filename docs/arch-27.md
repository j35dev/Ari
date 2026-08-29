# M27.1 — In-window launch moment architecture notes

Startup is one surface. The "Ari awakens" animation is the app window's own
first frame instead of a separate always-on-top splash window.

## What it replaces

M24.5 shipped the animation as a standalone frameless `BrowserWindow`
(760×560, `resources/splash/index.html`, packaged via `extraResources`), which
the main process closed once the real window signalled `ready-to-show`. Users
saw two surfaces at launch: a small centered animation, then the app appearing
at a different size and position. `src/main/splash.ts`, the loose HTML resource,
and the `extraResources` entry are gone; so is the renderer's older
`BootSplash` (the ARI-letters progress sweep), which had become a second,
redundant boot screen behind the first.

## Sequence

1. `createMainWindow()` builds the window hidden, at its persisted bounds, as
   before. Nothing else is created.
2. The renderer entry (`main.tsx`) sets `data-ari-booting` on `<html>` before
   React mounts. `awaken-splash.css` paints the launch canvas from that flag, so
   the first painted frame is already the animation's background rather than the
   themed app background.
3. `ready-to-show` fires on that first painted frame and the window shows —
   full app size, animation already on screen. The auto-updater starts here.
4. `AwakenSplash` runs the sequence (bloom → spark → arc → horizon → A → star →
   wordmark → caption) and plays the synthesized signature sound.
5. `App` pings the engine. Once it answers, `Shell` mounts *underneath* the
   splash, so the app is fully painted before it is revealed.
6. The outro (logo swell + veil wipe, 640ms) plays, `onDone` fires, `App` drops
   the splash and clears `data-ari-booting`.

## Handover rules

- `AWAKEN_MIN_MS` (2.8s) is a floor: a fast boot never truncates the sequence
  mid-beat. It is sized to let the last beat (the caption, 2.10s + 0.6s) land.
- The engine gate is the existing `ping`; slow driver detection keeps the
  animation up rather than showing an empty shell.
- `AWAKEN_MAX_MS` (12s) is a ceiling on the whole moment, preserving the old
  splash window's guarantee that startup can never hang behind the animation.
  `App` forces `booted` at the same deadline, so what the outro reveals is the
  shell, not a blank window.
- Handover is once-only (`doneRef`), so a re-render or the ceiling cannot fire a
  second transition.

## Styling

`awaken-splash.css` (feature-local, next to the component, like
`transcript.css`) owns the layout, the choreography, and the outro. Keyframes
stay in CSS rather than becoming Tailwind arbitrary values: it is one long
timeline and reads better as a timeline.

Colors come from `--ari-awaken-*` in `packages/ui/src/tokens.css`, the only
place literals may live. They sit in an `html` block rather than the bare
`:root` one for two reasons: the launch palette is brand, deliberately identical
under all six themes, so it is not a theme token and takes no part in the
registry mirror; and the boot canvas rule needs the value on the root element
before React mounts.

Reduced motion is honored — the brand still shows, it just arrives assembled.

## Sound

`awaken-sound.ts` synthesizes the signature with Web Audio (filtered breath,
C–E–G lift, high shimmer), so there is no audio asset to ship. It returns a
disposer that closes the context, and every failure path is swallowed: a launch
must never break over audio. Chromium's autoplay gate is still opened by
`--autoplay-policy=no-user-gesture-required` in `src/main/index.ts` — now for
the app window rather than the splash window.
