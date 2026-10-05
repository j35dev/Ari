# Ari Mobile — pairing fix, session controls, and visual rework

**Date:** 2026-10-05
**Status:** Awaiting owner review
**Branch:** `feat/m15.1-mobile-workbench` (draft PR #247)
**Scope:** `apps/mobile`, `packages/contracts`, `packages/remote-gateway`,
`apps/desktop` (remote host, catalog, Mobile access settings). The Ari Connect
repository needs no code change; its hosted copy of the PWA is rebuilt from this
tree.

## Goal

Make the installed PWA something the owner reaches for instead of the desktop:
it pairs from the home screen, offers the same model / effort / permission
controls as the desktop composer, and reads as a finished native chat app.

Success means:

- An iPhone home-screen install can be paired without Safari, a clipboard, or a
  second device.
- A phone can read and change a session's reasoning effort and permission mode,
  at creation and mid-session.
- All six Ari themes are selectable on the phone.
- The session list, conversation, composer, approvals, pairing and settings
  screens share one visual system.

## Decisions already made

- **Permission mode: full parity.** The phone may choose `ask`, `allow-edits`
  or `full` for any session it can reach. This retires the rule in
  `2026-09-14-ari-remote-design.md` §5 that "mobile cannot raise the desktop's
  permission ceiling". The desktop's `defaultPermissionMode` remains the default
  for a session the phone creates without choosing.
- **Pairing uses a typed short code.** No in-app QR scanner in this work.
- **It stays a PWA.** No native shell.

## 1. Pairing

### Root cause

An iOS home-screen web app has storage separate from Safari, so the device key
Safari stored is not visible to the installed app. The installed app's only
pairing path is a pasted link carrying `#pair=<invitationId>`
(`PairScreen.tsx:63-83`). Scanning the QR opens Safari, where
`takeInvitationFromUrl` (`app-state.tsx:51-56`) removes the fragment at once, so
the address a user can copy has no invitation in it. The invitation id is
`inv_<uuid>`, which nobody will type.

### Design

The desktop shows a short code with the QR. The installed app accepts it.

- **Code.** `PairingService.begin` mints an 8-character code beside the
  invitation id: Crockford base32 (no `I`, `L`, `O`, `U`), 40 bits, from
  `randomBytes`. Displayed as `XXXX-XXXX`. It lives and dies with its
  invitation: same expiry, single use, cleared on redeem, cancel or deny.
- **Resolution.** New anonymous operation `pairing.resolve`, route
  `POST /pair/resolve`, body `{ code }`, result `{ invitationId }`. It is
  subject to the same origin and managed-access checks as `/pair/request`.
  Input is normalised before lookup: upper-cased, separators removed, `O→0`,
  `I→1`, `L→1`.
- **Attempt limit.** Each open invitation tolerates 8 failed resolutions
  gateway-wide. On the ninth its code is disabled; the QR and link still work,
  and the desktop shows "Too many wrong codes. Create a new pairing code."
  A failed resolve answers `not_found` whether the code is wrong, expired or
  disabled, so the response does not confirm which.
- **Trust is unchanged.** Resolving a code yields only the invitation id, the
  same thing a photographed QR yields. Pairing still completes on the desktop,
  with the confirmation code derived from the device key.
- **Desktop UI.** `RemoteSettings` shows the code under the QR, large and
  monospaced, with the caption "On an installed app, enter this code." The
  invitation in `RemoteState` gains `code: string | null`.
- **Phone UI.** `PairScreen` replaces the "Fresh pairing link" field with one
  field labelled "Pairing code". It accepts, in this order: a short code, a
  full `https://…#pair=…` link for this origin, or a bare `inv_…` id. A code
  is resolved through `pairing.resolve`, then the existing name-and-confirm
  step runs. Errors are specific: wrong or expired code, link for another
  address, desktop too old to accept codes (operation absent from
  `gateway.info` capabilities).
- **Avoiding the Safari detour.** On iPhone Safari (not standalone) the unpaired
  screen leads with "Add Ari to your Home Screen, then enter the pairing code
  in the app", and offers "Continue in Safari instead" for people who want
  that.

## 2. Effort and permission mode

### What exists

The engine already stores `effort` and `permissionMode` on a session, accepts
both on `session.update`, and applies them on the next turn. `session.get`
already returns both to the phone. The remote envelopes do not carry them, the
remote catalog does not list the options, and the host hardcodes the mode at
creation.

### Contract (`packages/contracts/src/remote.ts`)

- `remoteModelCatalogSchema.providers[]` gains optional
  `efforts: { id, label, description?, current? }[]` and
  `modes: { id, label, description?, ariMode, current? }[]`, the same shape as
  `RpcResults['providers.models']`.
- New query `models.efforts` with `{ driverKind, modelId? }`, result
  `{ efforts: … }`, for providers whose levels depend on the model.
- `session.create` and `session.update` envelopes gain
  `effort: string | null` (optional) and `permissionMode` (optional).
- `REMOTE_PROTOCOL_VERSION` stays 1; every addition is optional.

### Desktop host

- `remote-catalog.ts` takes `efforts(kind)` and `modes(kind)` and emits them;
  `rpc.ts` passes `effortsFor` and `modesFor`.
- `models.efforts` is wired to the existing `probeEffortsForModel`, through a
  new dependency threaded into both `createRemoteHost` call sites. Results are
  cached per `(kind, modelId)` for the life of the process so opening the
  picker does not spawn an agent each time.
- `createSession` uses the envelope's `permissionMode` when present, else
  `defaultPermissionMode()`, and passes `effort`.
- `session.update` forwards both fields; the "nothing to change" guard counts
  them.
- An `effort` id is refused with `unsupported_capability` unless it appears in
  `effortsFor(kind)` or the cached per-model list. `null` is always accepted
  and means the agent's default.
- Effort and mode changes are accepted in any session state, as on the
  desktop, and apply from the next turn. While a turn is running the phone's
  picker says "Applies to the next turn". Model changes keep today's
  idle-only rule.

### Tests and comments that change

`remote.test.ts:17-31,112-123`, `gateway.test.ts:406-426`,
`remote-host.test.ts:402-422,1023-1027`, and the comments at
`remote.ts:220-223` and `remote-host.ts:51-53,696-698`. Fork keeps rejecting
both fields: a fork inherits its parent.

### Phone

- `app.catalog` already refreshes every 15 s and is not schema-stripped, so the
  new lists arrive without client plumbing.
- **Feature detection.** The effort and mode chips render only when the
  session's provider row carries `efforts` / `modes` arrays. Against an older
  desktop the composer looks as it does today.
- `NewSessionRequest` and its stored command carry `effort` and
  `permissionMode`, so a restored creation keeps them.
- Effort display: the session's `effort`, else the option flagged `current`,
  else the first. A stored effort missing from the list shows as "Default".
  The chip is hidden when the list is empty.
- Mode display: provider labels from `modes[]` when present, else
  Ask / Edits / Full auto. The value sent is always the Ari mode.

## 3. Visual system and screens

Direction: one quiet surface, large type for the thing being read, controls at
thumb height, motion that explains where something came from. Everything uses
existing Ari tokens; no new colour literals outside `packages/ui/tokens.css`.

### Navigation

- The bottom tab bar is removed. The root is the session list. A session pushes
  over it with a 200 ms slide; back is the system gesture or the header button,
  through the existing `pushState` routes.
- Settings opens from a header button as a pushed screen.
- `Projects` and `Inbox` stop being destinations. Their content moves into the
  list as shelves and a filter. Old `?view=` URLs resolve to the list.

### Session list (home)

- Header: `ari.` wordmark, computer chip with connection dot, settings button.
- A project filter row: "All" plus one chip per shared project, starred first.
- Shelves, in order, each hidden when empty: **Needs you**, **Working**,
  **Pinned**, **Recent**, and **Archived** behind a toggle at the bottom.
- **Needs you** is the Inbox content: every page of `attention.list` (pending
  approvals, questions, failures), fetched as `NowScreen` does today, each row
  saying what is being asked. Without that operation it falls back to sessions
  whose status is `waiting-approval` or `error`. A failed fetch shows an error
  row in the shelf, never an empty shelf.
- Rows: title, then project · status or relative time. Status is words plus a
  dot, never colour alone. Press-and-hold opens Pin / Rename / Archive.
- Search is a field at the top of the list, revealed by scrolling up.
- Pull down to refresh. A round "new chat" button sits above the home
  indicator.
- Empty and unreachable states keep their current wording.

### New chat

Tapping "new chat" opens an empty conversation screen, not a form sheet. A
project chip sits above the composer beside the model, effort and mode chips.
Sending creates the session with the existing idempotency receipt, stores the
text as that session's draft, opens the session and submits the prompt. If the
prompt is not accepted the text is still in the composer, as today.

### Conversation

- User messages: right-aligned bubble, `surface-2`, 20 px radius, at most 85%
  width. Agent messages: full width, no bubble, no per-message name or avatar
  row. Timestamps appear between messages more than ten minutes apart.
- Tool activity: one row per call — icon, verb and target ("Read `app.ts`",
  "Ran `pnpm test`"), shimmer while live. Consecutive rows in a finished turn
  collapse to "N steps"; tapping expands, tapping a row shows its full input
  and result. Reasoning is one such row. Errors stay visible when collapsed.
- Code blocks: language label, copy button, horizontal scroll.
- A status capsule floats above the composer while the agent works: activity
  label and elapsed time. Jump-to-latest is a round button centred above it.
- Header: back, title with project · status beneath, a Changes button, and a
  menu holding Files, Terminal, Details, Fork and Archive.

### Approvals and questions

A dock replaces the composer while anything is pending: what the agent wants
(tool, then the command, path or diff in readable form, with the raw payload
one tap away), then the provider's own choices as stacked full-width buttons,
the least permissive allow first. Several pending items show "1 of 3" and
advance on answer. The top-of-scroll cards and the "Review ↑" banner go away.

### Composer

A rounded card: growing text area; beneath it "+" for attachments, the model,
effort and mode chips in a horizontally scrollable row, Steer when applicable,
and a round send button that becomes Stop while the agent works and the field
is empty. Queue, Steer and Stop keep their meanings and their receipts.

### Pickers and sheets

- Model, effort and mode each open a bottom sheet with one row per option: a
  label, a one-line description, and a check on the current one. The model
  sheet keeps search and the provider row.
- `BottomSheet` gains drag-to-dismiss and a 220 ms spring; focus trapping and
  Escape stay.

### Themes

- Settings → Appearance: "System" plus six swatch cards (Obsidian, Graphite,
  Nocturne, Verdant, Porcelain, Sandstone), each a miniature of its surfaces
  and accent, grouped Dark and Light.
- `<meta name="theme-color">` is updated to the active theme's `--ari-bg` on
  every theme change, so the browser chrome and Android status bar follow.
- The choice stays local to the phone.

### Pairing and settings screens

Restyled on the same system. Settings keeps its sections: computer,
appearance, this phone's access, install hint, diagnostics, forget.

### Motion and accessibility

Transitions are 180–220 ms and are removed under `prefers-reduced-motion`.
Touch targets stay at 44 px or more. Every state conveyed by colour is also
conveyed by text or shape. The layout continues to size to
`visualViewport.height` with the composer in a flex column, never
`position: fixed`.

## Not in scope

In-app QR scanner. Theme sync with the desktop. Push notifications. Effort or
mode on fork. Wallpapers. Tablet-specific layout beyond the existing 720 px
column. Any Ari Connect service change.

## Delivery order

Each step is one or more commits of about 400 changed lines or fewer, with
`pnpm verify` green before each.

1. Pairing: short code in the gateway and contracts, desktop display, phone
   entry.
2. Remote effort and permission: contract, catalog, host, tests.
3. Composer chips and pickers, in sessions and new chat.
4. Themes: picker and `theme-color`.
5. Session list and navigation.
6. Conversation, tool rows and the approval dock.
7. New-chat flow.
8. Pairing and settings screens.

## Testing

- **Gateway and contracts:** unit tests for code minting, normalisation,
  resolve, expiry, single use and the attempt limit; envelope tests for the new
  fields; host tests for creation and update with effort and mode, and refusal of
  unknown effort ids.
- **Mobile:** component tests against the real gateway fixture for code entry,
  chip visibility with and without catalog lists, picker selection sending the
  right command, the approval dock, shelf grouping, and theme selection.
- **Layout:** 360 and 390 px widths, each theme, reduced height.

### Owner device checks

These cannot be automated here and are for the owner on a real iPhone:

- Keyboard open and close keeps the composer visible in the installed app.
- Safe areas at the top and bottom of every screen.
- Status-bar text legibility on Porcelain and Sandstone. The meta tag
  `apple-mobile-web-app-status-bar-style` is `black-translucent` today, which
  draws light text; if the light themes are unreadable there, the follow-up is
  switching it to `default`.
- Pairing a fresh home-screen install with the typed code.
