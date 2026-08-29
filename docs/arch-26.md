# M26 — Wallpaper compositing architecture notes

Bundled background scenes composited under the themed UI. Tasks M26.1 (scenes,
scrim, glass planes) and M26.2 (visibility look presets).

## Composite model

When a wallpaper is active, `<html>` carries `data-ari-wallpaper="<id>"` (set by
ThemeProvider alongside its other `data-ari-*` attributes; removed entirely for
`'none'`). All painting is pure CSS in `packages/ui/src/wallpaper.css` — no
React layer component, so every root (shell, settings, gallery) composites the
same way:

1. canvas — body's opaque `--ari-bg` (also the pre-paint fallback)
2. `body::before` — the wallpaper image, `position: fixed; z-index: -1`,
   `cover/center`
3. `body::after` — the scrim: a veil of the theme's own background color whose
   strength/blur the visibility look selects (below)
4. the app — in-flow content always paints above the two negative-z layers

Because body's background propagates to the canvas, the negative-z layers sit
above it and below everything else; tree order puts the image under the scrim.

## Visibility looks (M26.2)

`data-ari-wallpaper-look` ('subtle' | 'balanced' | 'vivid', default
'balanced') keys three scrim recipes, defined as custom properties so the
media-query block can re-derive them in one place:

- **subtle** — the original M26.1 feel: 72% veil, blur(22px). Text contrast
  never depends on anything else; the scene is a dim wash.
- **balanced** (default) — blur(14px) over a 38% veil: the scene stays
  recognizable behind the UI.
- **vivid** — no global blur, 26% veil: the scene is crisp. The main pane
  (`main.bg-bg`) then wears the same frosted plate as the sidebar — the
  `.ari-glass` recipe (`--ari-glass-scrim` + blur(28px) saturate(1.35)) — so
  the reading area is visually continuous with the chrome and text keeps the
  sidebar's readability over any scene. Its children are lifted above the
  plate via `position: relative`.

Veil colors always derive from `--ari-bg` via `color-mix`, so all six palettes
tint their wallpaper automatically; the look changes *how much* scene shows,
never *whose* color is in front.

## Theme interaction

No theme palette changed. The glass plane tokens
(`--ari-glass-scrim/overlay/input`) are re-derived from the surface ramp via
`color-mix` under `[data-ari-wallpaper]`, so all six palettes get translucent
chrome planes. `wallpaper.css` imports after `tokens.css`/`glass.css` and is
unlayered, so it wins cascade ties at equal specificity.

`data-ari-glass` semantics are untouched: it still means "blur allowed". With
glass off (or `prefers-reduced-transparency: reduce`), wallpaper planes stay
translucent — a wallpaper is an explicit opt-in to seeing one — but unblurred,
with all look veils raised under the media query.

Deliberately opaque over the wallpaper (legibility surfaces): the terminal
workspace, file explorer, settings pane, error boundaries, gallery, and the
welcome inputs — they keep painting `bg-bg`/surface tokens. The main session
pane's `bg-bg` is the one shell surface cleared (`[data-ari-wallpaper]
main.bg-bg`), which is what lets the composite show behind the transcript.

## Persistence and registry

`appearance.wallpaper` + `appearance.wallpaperLook` in
`@ari/contracts/settings.ts` (defaults `'none'` / `'balanced'`), carried
through the existing ThemeProvider preference pipeline: localStorage
pre-hydration cache, engine `settings.update`, hydration gate. The id unions
exist twice by design (contracts stays UI-free); `window.test.ts` pins the
wallpaper union equal, as it does for themes. `applyCachedTheme` drops a stale
look value and omits the attribute when no scene is active.

Assets live in `packages/ui/src/assets/wallpapers/*.jpg` (2560px, ~0.4–0.6 MB each,
recompressed with ffmpeg), imported by `packages/ui/src/wallpapers.ts` so Vite
emits them into `out/renderer/assets` (shipped by electron-builder's `out/**`
glob; CSP `img-src 'self'` already covers them). `wallpapers.test.ts` enforces
a per-file size budget.

## Picker

Appearance settings gains a Wallpaper radiogroup (None + each scene) using the
theme card pattern with 16:9 thumbnails, plus a Wallpaper visibility
segmented control (Subtle/Balanced/Vivid) that only renders while a scene is
active; both flow through `useTheme` setters so persistence and the html
attributes stay in sync. Settings search indexes the section.
