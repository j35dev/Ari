# Ari design language

Ari is a desk where one developer runs several coding agents on local
repositories. The interface has one job: let them read what the agents did and
decide what happens next. Everything here follows from that.

The reference is `mockups/ui-revamp/v2.html` (with `v2.css`); open it in a
browser and look at it before changing a surface. Where this document and the
mockup disagree, the mockup wins on looks and this document wins on rules.

## The idea

**A quiet frame around one stage, and the wallpaper as scene art.**

- The window is chrome: the titlebar and the sidebar sit directly on it, with
  no borders between them.
- The work happens on a **stage**: one rounded panel on the theme background.
  A docked panel (changes, files, terminal, browser, Aria's overview) is a
  second stage beside it.
- An empty stage shows the **scene**: the wallpaper drawn sharp at the top and
  dissolved into the page with an ordered dither. This is the one loud thing
  in the app. Nothing else decorates.
- **Aria** is the only character. Her pixel mark and her name in pixel type
  appear where she is, and nowhere else.

If a screen feels busy, the fix is to remove or collapse something, never to
restyle it louder.

## Principles

1. **One line until asked.** Agent work is a single grey line ("Worked for
   1m 13s"). Steps, output and diffs appear when the user opens it. Several
   agents are one row with a count; detail lives in the overview panel.
2. **Text before boxes.** A control reads as text until it is hovered: model,
   effort, permission mode, branch. No chip borders, no pill outlines.
3. **Ink is the primary action.** The filled button in a group is `bg-fg
text-bg`: white on dark themes, near-black on light ones. The accent is
   reserved for "needs you", focus rings, links, unread counts and the dot in
   the wordmark.
4. **Washes, not steps.** Hover is `bg-fg/6` (rows `bg-fg/5`), selected is
   `bg-fg/9`. Do not hover to `surface-2` or select with `bg-accent/15`; a wash
   reads the same on chrome and on the stage in all fifteen themes.
5. **One edge.** The stage border is the structure. Inside a stage, separate
   with space first, a hairline second, and a filled surface only for things
   that are objects (the composer, a user message, a code block, a card of
   settings).
6. **Status is one vocabulary.** Working is a spinning ring, needs-you is an
   accent dot, done is a grey check, failed is a red dot, queued is a dashed
   ring, interrupted is a grey stop square, and idle or removed is a faint
   point. Use `<span class="ari-status" data-status="working|attention|done|error|queued|stopped|idle">`
   (styles/frame.css). No coloured words like "Working", no emoji, no badges
   that restate the glyph.
7. **Sentence case, plain words.** No uppercase labels, no tracking, no
   middle-dot chains of metadata, no arrows appended to links. Mono type is for
   code, paths, commands and diff counts only.

## Tokens

All colour comes from `packages/ui/src/tokens.css` through Tailwind utilities.
Never write a colour literal in a component.

| Role            | Utility                                                                  | Use                                                                                   |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Stage           | `bg-bg`                                                                  | The content panel.                                                                    |
| Chrome          | `bg-surface-0`                                                           | Window frame, sidebar, titlebar. Also wells sunk into the stage (code blocks, diffs). |
| Object          | `bg-surface-1`                                                           | Composer, cards, menus, popovers.                                                     |
| Raised object   | `bg-surface-2`                                                           | User message, segmented control track, avatar tiles.                                  |
| Hairline        | `border-border`                                                          | Stage edge, dividers inside cards.                                                    |
| Strong hairline | `border-border-strong`                                                   | Composer edge, menu edge, outline buttons.                                            |
| Text            | `text-fg` / `text-fg-muted` / `text-fg-subtle`                           | Primary / secondary / captions, ages, placeholders.                                   |
| Accent          | `text-accent`, `bg-accent`                                               | Needs-you, counts, focus, links. Rare.                                                |
| Diff            | `text-success` / `text-danger`, `bg-success-subtle` / `bg-danger-subtle` | `+12 −3` and diff line tints only.                                                    |

Radius: `rounded-sm` 6, `rounded-md` 9, `rounded-lg` 12, `rounded-xl` 16,
`rounded-2xl` 20. Controls and rows are `rounded-md`; cards, menus and panels
`rounded-xl`; the composer and user messages `rounded-2xl`. Pills
(`rounded-full`) are for count badges and the send button only. Some themes
override the radii; always use the tokens.

Shadow: `shadow-2` under the composer, `shadow-3` under menus, popovers and
dialogs. Nothing else casts a shadow.

Motion: unchanged. Use `@ari/ui/motion` and the `ari-enter-*` classes; nothing
on a click path runs longer than 200ms.

## Type

The UI font is the user's choice (default Geist); never hard-code a family.

| Text                           | Size                                           | Weight                    | Colour                        |
| ------------------------------ | ---------------------------------------------- | ------------------------- | ----------------------------- |
| Sidebar and menu rows, pickers | 13.5px (`text-[13.5px]`) or 13px               | 400                       | `fg-muted`, `fg` when current |
| Project names, card row titles | 14px (`text-sm`)                               | 500                       | `fg`                          |
| Captions, ages, section labels | 12px or 12.5px (`text-xs`)                     | 400                       | `fg-subtle`                   |
| Conversation prose, composer   | `var(--ari-chat-text)` (15px at default scale) | 400                       | `fg`                          |
| Page titles (settings, home)   | 24px                                           | 600, `tracking-[-0.02em]` | `fg`                          |
| Code, paths, diff counts       | 12.5px mono                                    | 400                       | `fg-muted`                    |

Never go below 11px. Avoid `text-2xs` for anything a person has to read.

## Recipes

Use `apps/desktop/src/renderer/src/lib/recipes.ts` instead of rebuilding these:
`iconButton`, `iconButtonActive`, `rowAction`, `row`, `rowSelected`,
`sectionLabel`, `textButton`, `primaryButton`, `outlineButton`, `quietButton`,
`card`, `menu`, `menuItem`, `tab`, `tabSelected`, `chip`, `countBadge`, `cx`.
In `packages/ui` use the `Button` variants, which carry the same looks.

Icons are lucide at 16px (14px inside 28px buttons and dense rows), stroke
1.6 to 1.75. An icon never carries meaning alone without an `aria-label`.

## Surfaces

**Titlebar** (44px, on chrome, no border). Leading zone as wide as the sidebar:
the wordmark, search, collapse. Then the place: `project / session` with the
session in `fg`. Trailing: the git control (branch, `+n −n`) and the panel
toggles. Nothing else.

**Sidebar** (on chrome). Nav rows: New session, Aria. Then "Projects": a
project is a 34px row with a small letter tile; its sessions are 32px rows
indented under it, title left, age or status glyph right. Children of a lead
session nest one level on a hairline tree line. Footer: usage, focus, settings.

**Conversation.** A centred column (`.ari-chat-column`). The user's message is
a right-aligned `bg-surface-2 rounded-2xl` block, at most ~72% wide. Agent
prose is unboxed. Finished work collapses to one line; open, it is a list of
one-line steps on a single hairline (icon, verb, object in mono, duration or
`+n −n` at the right). A turn ends with its duration, copy, and the files it
changed as chips.

**Agents.** Delegated sessions are one row: overlapping provider tiles, "3
agents", then the state in words with needs-you in the accent, elapsed time,
chevron. Opened, each agent is one row with the status glyph, its title, what
it is doing now, and Review or Answer when that is the next step.

**Composer.** One `rounded-2xl bg-surface-1` box with `border-border-strong`
and `shadow-2`. Text on top; one row below: attach, then model, effort and
permission as text pickers; at the right the microphone and a round send
button that is `bg-fg text-bg` when there is something to send. Things that
need an answer (approvals, questions, the agents row) attach to the composer's
top edge as a tab of the same width minus 14px each side.

The composer rests when it is empty and unfocused: one compact row with the
placeholder, the microphone and send, so the conversation gets the height
back. Clicking or focusing it opens the full two rows. It never rests over a
draft, attached images, a dictation, or anything waiting on the user.

**Dictation.** The picker row becomes "Listening", a level meter of 3px-wide
bars built from stacked square pixels in the accent, and a timer. The border
takes the accent at 50%.

**Scene.** `<DitherScene>` behind the empty session, the welcome view and
Aria's empty chat. Headings and pickers over it are `text-fg`; the composer
sits on top as usual.

**Aria.** Her chat has a slim header inside the stage: mark, "Aria" in
`ari-pixel`, and one sentence of state ("Leading 2 projects. 2 sessions
working, 1 needs you."). Her overview panel groups the sessions she started
under "Needs you", "Working" and "Done".

**Panels.** A docked panel is a stage with a 44px tab row (Changes, Files,
Terminal, Browser) and content below. The primary action for the tab (Commit)
sits at the right of the tab row.

**Settings and pages.** A 680px column: page title, one-line description,
then groups. A group is a caption and a `card` of rows divided by hairlines;
each row is a label, a grey description, and one control at the right.

**Visualizations.** A chart an agent sends is a card with a title, the data,
and icon controls that stay faint until it is hovered: flip bars, data table,
copy, open larger. Marks are thin (bars at most 24px, lines 2px), rounded at
the data end, parted by 2px of surface and never outlined. Series take the
eight `--ari-viz-*` hues in order, the same in every theme; the accent and
status colours never stand for a series. One series has no legend, and one
hue: more than eight bars, or long names, become ranked rows with the value at
each tip. A long line fits the reply and thins its labels. Text is always in
text ink. Agents' near-miss shapes (`data` for `values`, `name` for `label`,
quoted numbers) are repaired in `packages/contracts/src/visualization-repair.ts`
before the strict schema runs.

**Scrollbars.** One look for every scroller, set once in
`packages/ui/src/scroll-area.css`: no track, no arrows, a 4px thumb in the
text colour at low opacity. It lifts when the pointer is over its scroller and
thickens under the pointer. Never set `scrollbar-width` or `scrollbar-color`
on an element: Chromium then draws its own bar instead, arrows included.

## Writing

Name things by what the user does. Buttons say what happens ("Allow once",
"Review", "Answer"). Empty states say what to do next. Errors say what went
wrong and how to fix it, without apology. No exclamation marks.

## What must not change

Tests assert on these, and so do users' habits:

- Every `aria-label`, button name, heading and visible string that a test
  queries. Restyle; do not rename. If copy must change, update the test in the
  same change and say so.
- `.ari-*` class hooks (`.ari-composer-shell`, `.ari-composer-dock`, `.ari-md`,
  `.ari-status-capsule`, `.ari-user-bubble`, `.ari-wallpaper-pane`, ...).
- State classes that tests check: `bg-accent/15` on the active sidebar row,
  `border-accent/40` on the active split pane, `bg-accent-subtle` in the model
  selector. If a design rule above conflicts with one of these, change the
  component and the test together.
- The z-index scale (`z-popover`, `z-overlay`, ...): no raw `z-[n]`.
- Behaviour. This is a visual change. Do not alter data flow, RPC calls,
  keyboard shortcuts or focus management.
