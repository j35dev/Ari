/**
 * Font loading. Geist + Geist Mono are bundled (OFL-licensed) so rendering is
 * identical across Windows, macOS, and Linux.
 *
 * This is a TS module rather than a CSS file on purpose. Reaching the fonts
 * through a CSS `@import` chain let Tailwind inline them before Vite could
 * rebase their `url()` references, so the woff2 files were never emitted into
 * production builds and packaged apps silently fell back to system fonts.
 * Importing here keeps them in the JS module graph, where Vite's asset
 * pipeline hashes and emits them. It also resolves the fontsource packages
 * from this package, which is where they are declared.
 */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
