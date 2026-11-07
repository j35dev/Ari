# Desktop close and background lifetime

With a working system tray, closing Ari hides its existing window. Agent turns,
terminal shells, pending scheduled prompts, and explicitly enabled phone access
keep their existing owners while the computer is running and awake. The tray
shows **in background**, alongside the existing mid-turn count. **Show Ari**,
launching Ari again, and macOS activation restore and focus the same window.
**Quit** stops Ari and its services.

Idle Close deliberately hides too, on all three desktop platforms. This keeps
unsent drafts and live subscriptions, and provides one understandable rule:
Close hides; Quit exits. Ari remains in the tray after work finishes. It does not
automatically exit when a count reaches zero or introduce an additional setting.
The tray's idle count means no mid-turn turns; it does not imply that no scheduled
prompt, terminal shell, or phone listener exists.

This does not enable phone access, approve a device, change grants, install a
daemon, or prevent sleep. Existing pairing and reconnection paths use the same
in-process remote service. Work cannot continue while the computer is asleep,
off, or shutting down, and phone reachability still depends on the configured
network connection. Existing provider timeouts, retained-process idle limits,
and schedule semantics continue to apply.

## Ownership decision

The investigation baseline is `bb60fe286f6f0ee4878e1cf009da727e0e757202`.

| Owner                                | Existing lifetime and consequence                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main `BrowserWindow` / `webContents` | Hosts renderer drafts and subscription consumers. `window.close` calls the native `close()` path.                                                                                          |
| `registerRpc(contents)`              | Builds an engine, driver registry, RPC registry, scheduling/control runtime, terminals, browser service, and live source-control subscriptions. IPC handlers trust this particular sender. |
| RPC stream registry                  | Delivers to that `webContents`; replacement windows do not inherit subscriptions or renderer state.                                                                                        |
| Browser service / MCP                | Guest factory resolves the host from that `webContents`. Destroying it disposes guests and closes MCP. Agent guests already have their own offscreen rendering policy.                     |
| Control runtime / schedule           | Operate in the main process. Destroying and replacing only the window does not transfer these owners.                                                                                      |
| Phone service                        | Retains its original engine and state; re-registering RPC does not rebind an already existing remote singleton to a replacement engine.                                                    |
| Provider turns / ACP pool            | Active adapters belong to the engine. ACP disposal parks a transport; the pool owns that retained process between turns.                                                                   |
| Desktop terminals                    | Native PTYs belong to the RPC registration; all handles and child trees now close on shutdown or destruction of the owner.                                                                 |

At baseline, Close destroyed the renderer and `window-all-closed` called Quit on
Windows/Linux. macOS and tray recovery could create replacement windows; RPC
registration was duplicated on one path and omitted on another. Preserving one
window avoids that partial ownership migration. An activity-only hide rule would
also need a complete predicate spanning asynchronous schedule/settings loading,
retained agent work, and shells, rather than relying on the existing mid-turn tray
count. Retaining the same owner for idle Close is the smaller complete journey.

## Shutdown and recovery

- Explicit Quit marks the app as quitting before any native close event, so the
  hide handler cannot veto it. Runtime shutdown is idempotent and awaits cleanup.
- The engine stops admission, cancels live turns, disposes even a provider that
  ignores cancellation, and waits for startup/disposal. The owner closes retained
  ACP transports before waiting for streams and after late startup finishes.
  Queued work is not started during shutdown.
- Shutdown closes scheduling/control, desktop and phone terminals, remote
  listeners, browser guests/MCP, and live source-control/orchestration subscriptions.
  Startup gates check shutdown state so late initialization cannot reopen a
  service. In-flight initialization is cleaned up when it returns.
- Quit has a five-second deadline before Electron exits. Provider teardown uses
  the existing transport/process-tree cleanup. OS termination or an unresponsive
  startup may preempt graceful cleanup; this is not a durable background runtime.
- Windows `query-session-end` and `session-end`, and macOS/Linux power-monitor
  shutdown, start the same Quit path without preventing the OS event. A cancelled
  OS shutdown request may therefore still quit Ari.
- A missing tray icon or tray-construction failure leaves a usable normal window
  and RPC startup. Close then quits on every platform. A partially created tray
  is destroyed on failure.
- If a tray status/recovery operation finds a destroyed or failed tray, Ari
  reveals its window and retires that tray. Launching Ari again remains a recovery
  path even when an idle hidden tray disappears without a status event.
  Electron cannot confirm that a desktop environment actually displays a
  successfully constructed tray icon; launching Ari again is also the recovery
  path when a Linux desktop suppresses its tray.
- An unexpectedly destroyed main `webContents` quits instead of manufacturing a
  replacement engine. A renderer-process crash reveals and reloads the existing
  `webContents` without registering RPC again. A crash can lose renderer-only
  drafts; ordinary Hide/Show does not reload or lose them.
- Main-frame load failure quits; aborted navigation and guest load failures do
  not. An early Close is not undone by a late `ready-to-show` event.
  The existing first-paint fallback reveals a stalled startup even without a tray.

## Deterministic coverage

`index.test.ts` drives the actual main entry point with headless Electron event
objects and the real window-control RPC/stream registry. It covers Close/Show,
idle behavior, native and RPC Close, first-paint races, second instance, macOS
activation, subscriptions, explicit Quit, OS termination, missing/lost tray,
renderer recovery, load/startup failure, and the Quit deadline.

`engine-shutdown.test.ts` uses a real session store and fake drivers to establish
cancellation/disposal ordering, ignored cancellation, late startup, retained
transports, and queued-work preservation. Terminal tests fake all process kills;
tray tests exercise actionable Show/Quit and partial-construction cleanup.
These tests do not launch Electron, a real provider, or a server. Native rendered
behavior and a real phone reconnect remain parent verification work.
