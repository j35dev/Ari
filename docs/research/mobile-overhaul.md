# Mobile overhaul review

Branch: machines/mobile-ui. Baseline: 6f018a75 (unchanged mobile source).

The redesign-existing-projects audit uses Ari's existing tokens, fonts and
components. No new palette, font library or framework is introduced.

## Audit

- Home has shelves, project filters, search and hold actions, but only Connect
  offers a computer selector. The host status occupies a narrow header with no
  route to another private computer.
- Device keys and pending prompt/create/fork/integration receipts already use
  origin/device storage. Component state and route history need the same boundary
  so matching session IDs cannot show another computer's content or attachments.
- Pairing already navigates to a private destination origin. A registry must keep
  that behavior and must never move keys between browser origins.
- The session workspace exposes conversation, approvals, changes, files,
  delegation, reviewed integration and granted terminals. Its offline/loading
  state needs a clear reconnect action and retained draft explanation.
- Provider approval choices can have long names. Composer controls and settings
  diagnostics need inspection at 360 and 390 pixels in both Ari themes.
- Empty/error/file/diff states exist. Loading and long unbroken paths need
  consistent containment and accessible state feedback.

## Verification plan

All installs, checks and captures use the swarm-wide run-heavy.mjs lock runner.
WIP is committed before each long step. Browser fixtures use local synthetic
workspace data and a fresh D: Chrome profile; no live Ari, saved settings, device
or Tailscale mutation. Baseline and after captures cover 360/390 light/dark.

Visible changes, final evidence, checks and limitations will be appended here.

## Complete visible-change list

1. Home has a full-width computer button above a Sessions heading. The connection
   label remains visible. Each shelf shows its session count, and the floating
   new-chat button now includes a text label.
2. The Computers sheet lists names, complete host/port addresses, the selected
   computer, current connection status and historical last-connected times.
   Private builds offer Add computer with a Tailscale address/pairing link and
   optional local name. Connect keeps its approved-account chooser.
3. A private computer switch opens the destination PWA root, including non-443
   ports, and preserves a pairing invitation. Public directory labels/addresses
   travel in a consumed fragment; phone credentials and session content do not.
   This may open a different browser/PWA storage context, which must be paired
   independently if it has not already been approved.
4. Session headers name the active computer alongside the project and status.
   Chat, Changes and Files have visible navigation buttons; Terminal appears
   only with its existing device grant. The active view is indicated. Files
   moves out of More; More retains granted Terminal, Usage and Details.
5. Offline session views explain that the draft stays local and offer a
   Reconnect action. A session that has not loaded has a reconnect empty state
   rather than an indefinite loading label. Sending and answering remain
   disabled until connected; approval choices are visibly disabled offline.
6. Approval/question docks can scroll within 65% of the available viewport.
   Long provider choice labels wrap and retain their exact wording.
7. Settings adds the computer selector and local Rename this computer form.
   Appearance is expandable so connection/access details remain near the top;
   all existing Ari themes and System mode remain available. Access copy says
   available projects and distinguishes the terminal permission.
8. Pairing includes the computer selector and no longer asks users to choose
   project grants. Matching-code approval remains on the destination desktop.
9. Button pressed feedback and wrapping use Ari tokens. Long paths, Markdown
   words and errors remain contained. Existing fonts, palettes, safe areas,
   keyboard viewport tracking, search/filter/hold actions and update flow remain.
10. Unsent new-chat draft text now survives leaving that screen for the same
    computer/device. Switching clears transient conversation, picker, attachment,
    file/diff/terminal view and subscription state from view. Returning restores
    only that origin/device's draft and exact uncertain command receipt.
11. Forget removes only the selected computer's local credential, directory
    entry, drafts, prompt/create/fork/integration receipts and terminal references.
    It aborts/disconnects the abandoned client. Local storage generations reject
    late pairing saves and clear after any already-running local write, without
    waiting for an offline gateway response.
12. Saved prompt/new-chat/fork/integration receipts are checked with read-only
    command status when Retry is tapped. Missing or malformed host history keeps
    the receipt and asks the user to inspect that computer; it never repeats the
    mutation. Shell creation polling and terminal input Retry follow the same
    rule. Existing button labels remain unchanged.
13. The older pairing address form now uses the computer selector's private
    root-address policy, retaining explicit ports and invitations. Selection is
    held while a local forget completes. Late workspace completions cannot send
    a first prompt, restore receipt/draft state or navigate an abandoned view.

## Screenshot evidence

`docs/screenshots/mobile/before` contains 40 PNGs: home, session/composer,
approval, error, empty, settings, files, changes, pair and offline at 360/390px
in light (Porcelain) and dark (Obsidian), each at 844px height.

`docs/screenshots/mobile/after` contains the same 40 comparisons plus 16 PNGs
for the Computers sheet, Add computer form, and 480px-high session/approval
views at both widths/themes. Evidence JSON records the fixture profile and
viewport overflow measurements. All captures use real components with synthetic
read-only workspace data, a fresh D: Chrome profile and the system Chrome.

Representative comparisons:

| View | Before | After |
| --- | --- | --- |
| Home, 360 light | [Before](../screenshots/mobile/before/360-light-home.png) | [After](../screenshots/mobile/after/360-light-home.png) |
| Session, 360 light | [Before](../screenshots/mobile/before/360-light-session.png) | [After](../screenshots/mobile/after/360-light-session.png) |
| Approval, 390 dark | [Before](../screenshots/mobile/before/390-dark-approval.png) | [After](../screenshots/mobile/after/390-dark-approval.png) |
| Changes, 360 light | [Before](../screenshots/mobile/before/360-light-changes.png) | [After](../screenshots/mobile/after/360-light-changes.png) |
| Settings, 390 light | [Before](../screenshots/mobile/before/390-light-settings.png) | [After](../screenshots/mobile/after/390-light-settings.png) |

Additional review: [Computers](../screenshots/mobile/after/360-dark-computers.png),
[Add computer](../screenshots/mobile/after/360-light-computer-add.png),
[short composer](../screenshots/mobile/after/390-dark-session-short.png),
[short approval](../screenshots/mobile/after/360-dark-approval-short.png).

## Verification and limits

- Baseline: 33 focused mobile tests, typecheck and production build passed.
- After: 119 tests initially passed; 9 reconnect assertions failed because the
  new banner duplicated the harness button's accessible name. After correcting
  the ambiguity, the complete affected group passed (24 tests, including two
  pairing/forget races). Remaining final storage/receipt regressions are recorded
  in the final commit report.
- Final mobile typecheck, focused lint and production build passed under the
  shared runner. All 96 screenshot captures passed page-width overflow checks.
  Initial fixture failures were corrected before the complete capture sets;
  no OOM/killed test/build step was retried.
- Shared contracts/client extraction and lifecycle guard were imported from C;
  device-key extraction and README grant wording remain untouched by E.
- No live Ari settings, device records, Tailscale mappings, user checkout,
  publishing, pushes or PRs were changed. No workers were delegated.
- Cross-origin browser storage cannot share non-extractable keys. Each private
  origin needs its own pairing; installed iPhone PWA/Safari contexts can differ.
  Physical keyboard/safe-area behavior, network/sleep/ACL/revocation on hardware,
  live managed broker/tunnel lease refresh, and the parent-wide integrated suite
  remain release verification. Fixtures do not claim those checks.

## Fresh-worker review, 2026-11-12

Starting snapshot: bd182168. The existing 96 captures are retained. Review found
that the UI's explicit receipt retries still called `send`, despite the shared
client's automatic-recovery hardening. E replaces those calls with authenticated
`command.status` queries, including terminal creation/input recovery. Regressions
cover missing/corrupt host history, per-device drafts, delayed pairing cancellation
and selecting a new connection during local forget. Final checks and screenshot
review evidence will be recorded after validation.

The parent accepted B's secure legacy-key decision: an old unscoped IndexedDB
credential has no trustworthy host binding. B preserves it without automatic
migration, requiring fresh pairing per origin. E does not edit B's key-store
implementation/tests or C's shared client; those dependencies must be integrated
and verified by the coordinator.
