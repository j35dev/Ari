# Agent-authored Ari themes

Users can send `/ari theme neon cyan with sharp corners` in any Ari chat. Ari
keeps that short request in the transcript and expands it into an authoring
brief at the provider boundary. The selected agent reads the live schema,
creates and validates a JSON package, and installs it in the local theme library.
The same CLI is available to Aria, project agents and child sessions.

## User flow

1. Describe a theme with `/ari theme <brief>` or ask an agent in ordinary language.
2. The agent runs `ari theme schema --json` (schema, design guide, CSS hooks,
   example), makes a theme folder with theme.json and its images (a wallpaper it
   generates or downloads, stickers, fonts), and runs
   `ari theme validate --file <path> --json`.
3. `ari theme install --file <path> --preview --json` stores the listed files,
   saves the package and requests a 30-second full-app preview.
   `ari theme screenshot --json` saves a PNG of the window so the agent can see
   the result and iterate before asking the user.
4. Keep theme saves the selected revision. Revert, or the preview timeout,
   restores the previous confirmed theme. Reloading during a preview also
   restores the confirmed theme.
5. Settings → Appearance → Your themes offers preview, import, export and removal.
   The protected Reset theme control and Ctrl/⌘+Alt+Shift+T restore Obsidian.

## Customization contract

The current schema is served by `ari theme schema --json`, together with the
component-slot list and a usable neon example. The version 1 package has a
`custom:<slug>` identity, name, description, bundled base palette, semantic
color overrides, bundled UI/code fonts, bounded density presets for spacing, corner radii, structured shadows,
background gradients, decorative scene preference, and component styles. It may
also carry `assets` (up to 32 png/jpg/webp/gif/avif/svg/woff2 files, 12 MB each,
40 MB per theme), a `wallpaper` (asset, blur, tint, focal position) that replaces
the bundled wallpaper while the theme is painted, and `css` (up to 50,000
characters) applied after Ari's styles. CSS references theme files as
`url("asset:<name>")`; emoji and stickers go in pseudo-element content.

Every registered component slot has default, hover, active, selected, focus and
disabled states. Slots cover the app frame, sidebar, titlebar, panels, composer,
messages, tool calls, settings, inputs, buttons, icons, dialogs,
menus, tooltips, tables, file and diff views, terminals, and scrollbars. Native
elements and shared recipes provide broad coverage; `data-ari-part` marks
specific surfaces. New components should use these shared recipes or advertise
an appropriate stable part. Tailwind selectors are never part of a theme file.

## Runtime guarantees and boundaries

The package is data plus CSS, not a plugin: no JavaScript or HTML. Structured
fields compile through Ari-owned selectors. Theme CSS follows T3 Code's model:
it targets the stable hooks served with the schema (`data-ari-part` and
`ari-*` classes, never Tailwind utilities) and must never load from the network,
because a `url()` on an attribute selector could send what is on screen to
another host. Validation refuses `@import`, `image-set()`, `src()`,
backslashes (so escapes cannot spell a function past the check) and any
`url()` other than `asset:`, `data:` or `#id`. At paint time the browser-parsed
sheet is filtered again and only `ari-theme-asset:` and `data:` survive; the
packaged CSP independently limits images, fonts and fetches to the app, data,
blob and the theme-asset scheme.

Theme files are stored once by SHA-256 under userData/theme-assets and served
read-only as `ari-theme-asset://a/<sha256>.<ext>`. Bytes must match the claimed
type. Content addressing means a revision never overwrites a file the confirmed
theme still uses; files no library entry or confirmed theme references are
removed after each library change. Exports embed the files as base64.

Schema validation runs at IPC/control and storage boundaries. Contrast checks
run before installation and painting, including inherited palette colors.
Geometry and shadow values are bounded. Keyboard focus remains visible.
The theme recovery bar and approval cards render in shadow roots that theme CSS
cannot select into or inherit through, so a theme cannot relabel, reorder or hide
their buttons. The recovery bar also sits in the browser's top layer, above
anything a theme paints. Approval cards are not a theme hook. Applying a theme
(`theme install --preview`, `theme preview`) and `theme screenshot` go through
the user's normal command approval; installing to the library does not.
The library is capped at 50 entries and 500 KiB to bound storage and control frames.

The engine settings store persists the library atomically. All library writers
share one queue so simultaneous agents cannot overwrite each other's entries.
Control mutations also use the existing authenticated caller and durable
idempotency receipts. Invalid packages do not update the library or live styles.

The confirmed custom package is saved separately from its editable library
entry. Revising an active theme therefore cannot overwrite the current design;
cancelling the replacement preview restores the confirmed revision, including
after restart. Native window chrome uses the same resolved palette. Themes
are local to the Ari installation; running an agent on another machine does not
grant it access to a different machine's appearance settings.

## Validation

Contract tests exercise injection attempts, unknown slots, illegal geometry,
version mismatches, contrast, duplicate IDs and explicit slash-command routing.
Runtime tests cover inherited contrast failure without changing the DOM,
selector isolation, removal, timed preview rollback, confirmed-revision rollback,
cache restoration and keyboard reset. Storage/control tests cover parallel
installation, persistence, unrelated settings, active-entry deletion, CLI parsing
and same-key installation deduplication.
