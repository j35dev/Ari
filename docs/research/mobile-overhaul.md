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
