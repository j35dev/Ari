# Ari Awakens — Dark Edition

A slower, darker version of the Ari startup animation.

## Design

- Near-black launch canvas instead of white.
- Ari icon proportions and geometry retained as the reference.
- Warm orange spark / arc / star.
- Off-white A and wordmark for dark-mode readability.
- Slight atmospheric bloom and subtle film grain.
- Longer, more deliberate sequence (~3.3s minimum).
- The real EDE should load in parallel and call `window.finishAriSplash()` when ready.
- Soft synthesized startup sound is built into the page, so there is no audio file dependency.

## Timing

The logo breathes for about 3.3 seconds before handing over.
If the EDE takes longer, the splash can stay until `window.finishAriSplash()` is called.
A standalone browser preview falls back at about 3.9 seconds.

## Sound

The sound is generated with Web Audio:
- quiet filtered "breath"
- three-note C–E–G lift
- subtle high shimmer at the final logo moment

It is intentionally restrained so it feels like a premium app signature rather than a game sound.
