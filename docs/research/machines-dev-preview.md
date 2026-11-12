# Machines development preview

2026-11-12, `feat/machines`, `D:/Projects/Ari-machines`.

The preview runs as **Ari Dev Machines**, with its own Windows AppUserModelID,
single-instance lock and profile at
`D:/Projects/.ari-cache/machines-dev-profile`. Renderer port is 5197. Gateway
port 8797 is selected, but hosting is off. Speech and Discord presence are off.
The installed Ari and the user's separate UI development instance/profile were
left untouched.

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

Validation of the small startup changes: seven dev identity tests passed;
desktop typecheck and scoped ESLint passed. Named overrides are ignored by
packaged installs and leave the default Ari Dev identity unchanged. `ws` remains
a declared desktop runtime dependency so its optional native peers are loaded
through its guarded Node code rather than a throwing Vite development placeholder.
The initial missing profile-version and environment-type fixtures were corrected
before the passing screen/typecheck checks.

## Final restart after verification

The publication full-check pause ended on 2026-11-13 with a launch from
`503d776e`, containing reviewed application runtime `da40bbef` and packaging
fixes through `d8c812ee`. Runner PID 29024 and Electron main PID 17060 are
responding at below-normal priority. The visible title is **Ari Dev Machines**,
renderer 5197 returned HTTP 200, and profile/AppUserModelID remain isolated.
Gateway 8797 has no listener because hosting is off. Installed Ari remains
PID 13384 on 8787. Startup logs show store/provider initialization with no fatal
error; ordinary Vite chunk warnings remain. This restart was verified by
process/title/log/HTTP observations; the earlier screen checks below are
historical, not newly repeated native UI automation. Later publication changes
are documentation/evidence only and do not alter the running application.

### Earlier completion restart

The approved verification pause ended with a restart from integration checkpoint
`d8107b7e545ce7520cc5a400529b4c66ad9e03e4`, containing final runtime source
`da40bbef99343f9dce054889cb336e7ba3977e25`. Subsequent handoff documentation does
not change the running runtime. The background runner is PID 10132; Electron
main is PID 27496. Both were responding and below normal priority. Windows
reports the visible main window title as **Ari Dev Machines**, and the renderer
at `http://localhost:5197/` returned HTTP 200. The installed Ari was independently
responding and continued to own port 8787. Machines port 8797 had no listener.
The saved Machines settings were checked: hosting, speech and Discord presence
are disabled, and the configured gateway port is 8797.

The restart checks cover process health, renderer HTTP and startup logs. The
earlier screen checks above and final normal-component screenshots provide UI
evidence. Logs show successful main/preload builds, isolated session-store
startup and provider registration. They also contain bundler warnings, Git
probe exit 128 for the isolated Aria support folder (confirmed not to be a Git
repository), and provider probe teardown `taskkill` exit 128 warnings. No startup
or renderer crash was observed. Real provider descendant cleanup remains part
of the hardware verification gates.

Ready to try: the normal project draft and first-Send lifecycle, This PC machine
selection, Machines settings, and the normal scoped session/tools. A separately
approved compatible tailnet host is needed for interactive remote selection and
Auto; no second preview host was started. Automated signed two-host proofs and
the independent security review passed. Headless execution and transactional
remote updates remain designed follow-ups. The complete disposition is in
[the final parity report](machines-parity-final-2026-11-12.md).

All eight completed Machines child sessions and their owned worktrees were
removed after result inspection/integration. The disposable security harness was
archived on D:; the lease directory and side-session worktrees remain intact.
