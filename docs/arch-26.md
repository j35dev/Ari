# M26 — Wallpaper compositing architecture notes

Bundled background scenes composited under the themed UI. Task M26.1.

## Composite model

When a wallpaper is active, `<html>` carries `data-ari-wallpaper="<id>"` (set by
ThemeProvider alongside its other `data-ari-*` attributes; removed entirely for
`'none'`). All painting is pure CSS in `packages/ui/src/wallpaper.css` — no
React layer component, so every root (shell, settings, gallery) composites the
same way:

1. canvas — body's opaque `--ari-bg` (also the pre-paint fallback)
2. `body::before` — the wallpaper image, `position: fixed; z-index: -1`,
   `cover/center`
3. `body::after` — the scrim: `color-mix(in oklab, var(--ari-bg) 62%, transparent)`
   plus `backdrop-filter: blur(20px) saturate(1.2)`, i.e. a frosted veil of the
   theme's own background color
4. the app — in-flow content always paints above the two negative-z layers

Because body's background propagates to the canvas, the negative-z layers sit
above it and below everything else; tree order puts the image under the scrim.
Chat text therefore never sits on raw wallpaper — it sits on the frosted scrim.

## Theme interaction

No theme palette changed. The scrim derives from `--ari-bg` and the glass plane
tokens (`--ari-glass-scrim/overlay/input`) are re-derived from the surface ramp
via `color-mix` under `[data-ari-wallpaper]`, so all six palettes tint their
wallpaper automatically and non-glass themes get translucent chrome planes too.
`wallpaper.css` imports after `tokens.css`/`glass.css` and is unlayered, so it
wins cascade ties at equal specificity.

`data-ari-glass` semantics are untouched: it still means "blur allowed". With
glass off (or `prefers-reduced-transparency: reduce`), wallpaper planes stay
translucent — a wallpaper is an explicit opt-in to seeing one — but unblurred,
with scrim/veil alphas raised under the media query.

Deliberately opaque over the wallpaper (legibility surfaces): the terminal
workspace, file explorer, settings pane, error boundaries, gallery, and the
welcome inputs — they keep painting `bg-bg`/surface tokens. The main session
pane's `bg-bg` is the one shell surface cleared (`[data-ari-wallpaper]
main.bg-bg`), which is what lets the composite show behind the transcript.

## Persistence and registry

`appearance.wallpaper` in `@ari/contracts/settings.ts` (`'none' | wallpaperId`,
default `'none'`), carried through the existing ThemeProvider preference
pipeline: localStorage pre-hydration cache, engine `settings.update`, hydration
gate. The id union exists twice by design (contracts stays UI-free);
`window.test.ts` pins both unions equal, as it does for themes.

Assets live in `packages/ui/src/assets/wallpapers/*.jpg` (2560px, ~0.4–0.6 MB each,
recompressed with ffmpeg), imported by `packages/ui/src/wallpapers.ts` so Vite
emits them into `out/renderer/assets` (shipped by electron-builder's `out/**`
glob; CSP `img-src 'self'` already covers them). `wallpapers.test.ts` enforces
a per-file size budget.

## Picker

Appearance settings gains a Wallpaper radiogroup (None + each scene) using the
theme card pattern with 16:9 thumbnails; selection flows through
`useTheme().setWallpaper` so persistence and the html attribute stay in sync.
Settings search indexes the section.
