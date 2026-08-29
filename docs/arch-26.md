# M26.1 — Wallpaper compositing architecture notes

Bundled background scenes shown through the app's own glass.

## Composite model

When a wallpaper is active, `<html>` carries `data-ari-wallpaper="<id>"` (set by
ThemeProvider alongside its other `data-ari-*` attributes; removed entirely for
`'none'`). All painting is pure CSS in `packages/ui/src/wallpaper.css`:

1. canvas — body's opaque `--ari-bg` (also the pre-paint fallback)
2. `body::before` — the scene, `position: fixed; z-index: -1`, `cover/center`
3. `.ari-glass-pane` — ONE continuous glass plate over the whole content area,
   carrying the exact recipe the sidebar and titlebar use
   (`--ari-glass-scrim` + `blur(28px) saturate(1.35)`)
4. content — panes, rows, cards, all above the plate

The app therefore reads like the sidebar does over a wallpaper everywhere:
translucent, lightly tinted, with no pane darker or blurrier than its
neighbor.

### Why one plate

Earlier iterations plated each pane separately (sidebar `.ari-glass`, then
`main.bg-bg`). Two failures showed up in live testing: tints stacked where
plates met, and `backdrop-filter` produced a visible fringe along the
sidebar/main seam — the "gap" that looked like a slit in the window. A single
plate has no seam. Structure comes from hairline borders instead
(`border-l border-border` on the session main pane and the settings content
section), and nothing inside re-tints: within the plate, `.ari-glass` chrome
and `.bg-bg` pane fills are forced transparent with their blurs cleared.

The class is applied to the three renderer roots in `App.tsx` — the shell, the
settings root, and the gallery root — so settings gets the same material as
the chat workspace. With no wallpaper active the class is inert (every surface
keeps its own opaque background), so the plain theme path is untouched.

Floating surfaces keep their own materials (`.ari-glass-overlay` for popovers,
dialogs, palette; `.ari-glass-input` for input plates) so they still read as
sitting above the plate.

## Theme interaction

No theme palette changed. The plate's tint and the overlay/input planes are
re-derived from the surface ramp via `color-mix` under `[data-ari-wallpaper]`,
so all six palettes tint their wallpaper automatically and non-glass themes
get the translucent treatment too (a wallpaper is an explicit opt-in to seeing
one). `wallpaper.css` imports after `tokens.css`/`glass.css` and is unlayered,
so it wins cascade ties.

`prefers-reduced-transparency: reduce` raises every tint and drops the plate's
blur, so contrast never depends on blur.

There is deliberately no visibility/intensity setting: iterations during live
testing shipped Subtle/Balanced/Vivid presets and the choice turned out to be
"make the whole app look like the sidebar", which is now the only behavior.
`appearance.wallpaperLook` is gone from contracts; zod strips the stale key
from persisted settings, and the provider ignores it in both the durable copy
and the localStorage cache.

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
a per-file size budget, and `wallpaper-css.test.ts` guards the CSS structure
(one plate, neutralizers present, no raw colors, no leftover look variants)
since jsdom cannot evaluate `backdrop-filter` or `color-mix`.

### Why the scene URL comes from JavaScript

`wallpaper.css` must not contain `url('./assets/…')`. It reaches the app through
`@import '@ari/ui/wallpaper.css'`, and Tailwind inlines that import before Vite
can rebase or hash the reference, so the literal path survived the production
build verbatim while the real files were emitted with content hashes. Dev worked
(the dev server resolves the path against the CSS file); packaged builds asked
for `assets/assets/wallpapers/…`, which does not exist — the wallpaper silently
did nothing while the picker thumbnails, which come from the JS import, rendered
fine. The provider now sets `--ari-wallpaper-image` from the registry's imported
URL (`new URL(…, import.meta.url)`, absolute at runtime) and the CSS reads that
variable. `wallpaper-css.test.ts` fails if a relative `url()` reappears.

The same trap had already eaten the fonts: `@import '@ari/ui/fonts.css'` meant
zero woff2 files were emitted, so packaged apps fell back to system fonts. Fonts
now load as a JS module (`@ari/ui/fonts`), which keeps them in Vite's asset
graph. Rule of thumb for this repo: assets referenced from a CSS file that
travels through `@import` will not survive the build — reference them from
TypeScript.

## Picker

Appearance settings has a Wallpaper radiogroup (None + each scene) using the
theme card pattern with 16:9 thumbnails; selection flows through
`useTheme().setWallpaper` so persistence and the html attribute stay in sync.
Settings search indexes the section.
