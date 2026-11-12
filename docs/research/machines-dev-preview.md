# Machines development preview

2026-11-12, `feat/machines`, `D:/Projects/Ari-machines`.

The preview runs as **Ari Dev Machines**, with its own Windows AppUserModelID,
single-instance lock and profile at
`D:/Projects/.ari-cache/machines-dev-profile`. Renderer port is 5197. Gateway
port 8797 is selected, but hosting is off. Speech and Discord presence are off.
The installed Ari and the user's separate UI development instance remain running.

The shared Ari Dev profile's four changed keys were restored from the prelaunch
backup: speech enabled, remote enabled, remote port and Discord presence. No
other saved key was changed during restoration. The Machines profile is separate.

Launch from the integration worktree in PowerShell:

```powershell
$env:ARI_DEV_INSTANCE = 'machines'
$env:ARI_DEV_USER_DATA = 'D:/Projects/.ari-cache/machines-dev-profile'
$env:ARI_DEV_RENDERER_PORT = '5197'
./scripts/coordination/launch-machines-dev.ps1
```

The background helper runs below normal priority and holds one resource lease
for its lifetime. Main/preload changes restart Electron; renderer changes reload
through Vite. Only one other heavy step may run. Logs are
`D:/Projects/.ari-cache/machines-dev-reload.log` and `machines-dev-reload.err.log`.

The visible window loads the home composer, Appearance, Machines and Mobile
access. Mobile access correctly identifies the existing 443 mapping to the
non-listening loopback service on port 3773. These checks only read Serve status.
The normal desktop project draft, machine selector, unified repository sidebar,
scoped session/tools, routes and permissions are now integrated. A project draft
uses This PC initially; add an eligible paired host to exercise remote selection.
There is no second interactive preview host. Disposable HTTP loopback is confined
to automated tests; production rejects it. Final parity checks and the independent
review are recorded separately from these initial screen checks.

Use the **Ari Dev Machines** tray menu's Quit to stop it. Closing its window hides
it in the tray. Do not use Serve enable/replacement/removal controls during this
preview, or provider Update controls, which can change machine-wide state.
No second fixture host has been started yet.

Validation of the small startup changes: seven dev identity tests passed;
desktop typecheck and scoped ESLint passed. Named overrides are ignored by
packaged installs and leave the default Ari Dev identity unchanged. `ws` remains
a declared desktop runtime dependency so its optional native peers are loaded
through its guarded Node code rather than a throwing Vite development placeholder.
The initial missing profile-version and environment-type fixtures were corrected
before the passing screen/typecheck checks.
