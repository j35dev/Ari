# Agent-authored Ari themes

Users can send `/ari theme neon cyan with sharp corners` in any Ari chat. Ari
keeps that short request in the transcript and expands it into an authoring
brief at the provider boundary. The selected agent reads the live schema,
creates and validates a JSON package, and installs it in the local theme library.
The same CLI is available to Aria, project agents and child sessions.

## User flow

1. Describe a theme with `/ari theme <brief>` or ask an agent in ordinary language.
2. The agent runs `ari theme schema --json`, creates the package and runs
   `ari theme validate --file <path> --json`.
3. `ari theme install --file <path> --preview --json` saves the validated package
   and requests a 30-second full-app preview.
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
background gradients, decorative scene preference, and component styles.

Every registered component slot has default, hover, active, selected, focus and
disabled states. Slots cover the app frame, sidebar, titlebar, panels, composer,
messages, tool calls, approvals, settings, inputs, buttons, icons, dialogs,
menus, tooltips, tables, file and diff views, terminals, and scrollbars. Native
elements and shared recipes provide broad coverage; `data-ari-part` marks
specific surfaces. New components should use these shared recipes or advertise
an appropriate stable part. Tailwind selectors are never part of a theme file.

## Runtime guarantees and boundaries

The package is data, not a plugin. Ari owns selectors and compiles an allowlist
of visual properties. No arbitrary CSS, JavaScript, HTML, URLs, downloaded
fonts, layout positioning, display, visibility, pointer events, z-index,
content replacement or DOM changes are accepted. Theme authors can redesign
the visual treatment; navigation structure, element ordering, hit targets,
window dragging and component logic remain owned by Ari. Version 1 does not
offer arbitrary layouts, replacement components, user icon packs or custom
animation code. These would need separate, tested extension contracts.

Schema validation runs at IPC/control and storage boundaries. Contrast checks
run before installation and painting, including inherited palette colors.
Geometry and shadow values are bounded. Keyboard focus remains visible.
Recovery controls live outside theme selectors and carry their own fixed colors.
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
