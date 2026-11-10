# Dictation destinations

The installed `D:/ari/resources/app.asar` identifies itself as v0.3.12. Its
`AriaWidget.complete` path unconditionally calls `sendToAria`, which opens Aria
and dispatches `message.enqueue`. Fresh upstream main (`50ee55d2`) has the same
route and one configurable speech shortcut. A composer microphone uses a
different recorder. Its ordinary insertion already uses the textarea's live
selection and `setText`, so that path can work. The concrete regression reproduced
here is moving the selection while transcription is pending: completion inserts
at the later caret instead of the captured insertion point. There is also no shared
capture ownership between the composer and widget, or focus/draft invalidation at
completion. These are routing/lifecycle defects; the user's physical microphone
failure was not independently reproduced with a real microphone.

## Behavior and settings

| Control                     | Windows/Linux default | macOS default      | Completion                                                        |
| --------------------------- | --------------------- | ------------------ | ----------------------------------------------------------------- |
| Aria dictation shortcut     | `ctrl+alt+space`      | `shift+meta+space` | Existing Aria enqueue/send intent                                 |
| General dictation shortcut  | `ctrl+alt+d`          | `shift+meta+d`     | Insert into the captured focused field; never submit              |
| Session composer microphone | Button                | Button             | Insert into that session's captured draft/selection; never submit |

Settings exposes separate editable bindings. `speech.shortcut` remains the Aria
binding so existing customization retains its intent. `speech.dictationShortcut`
migrates to the new default. If the legacy Aria binding already uses that default,
general dictation migrates to `ctrl+alt+shift+d`. Conflicting bindings, existing
Ari actions, invalid chords, and known reserved OS chords are rejected. Settings
updates remain serialized and atomic; model selection is preserved.

A shared main-process lease spans acquisition, recording, transcription, and
insertion. A renderer crash/navigation releases it. Shortcut recording holds the
same lease so recording a binding cannot start dictation. Cancellation, shutdown,
disabled speech, and stale results discard the target. A quick shortcut release
before target acquisition cancels without recording. Empty transcription inserts
nothing. Errors have no Aria fallback.

The composer focuses and captures its own textarea, including the original draft,
selection, and session identity, before microphone acquisition. Pointer presses
on its mic retain that caret. Completion uses the captured element instead of a
later callback. Editing, moving the selection, changing session, disabling/removing
the field, or changing focus invalidates insertion. Window blur also cancels its
capture. Enter stops recording and is consumed during pending transcription;
Escape cancels. React receives a native input event so the session draft persists.

## Windows external fields

The non-focusable recording pill uses `showInactive`; it does not move the caret
or activate Ari. The foreground HWND is captured before the asynchronous native
request. A separate Electron utility process uses COM MTA and UI Automation to
verify the exact enabled, editable, non-password control, TextPattern selection,
and unchanged document. It rechecks these before insertion and observes focus
while capture is active. It waits for shortcut modifiers to be released, then
uses a single Unicode `SendInput` batch without an Enter key or paste command.
Clipboard contents are never read or replaced by the product implementation.

Unresponsive native providers are bounded and their utility process is stopped,
preventing late insertion. Windows permissions/UIPI are respected; insertion into
elevated or unsupported controls may fail with a visible error. Fields exposing
only ValuePattern cannot safely preserve a caret and are deliberately unavailable.
External applications must expose a usable TextPattern. No contenteditable,
terminal, or arbitrary non-text destination is guessed.

macOS and Linux retain their existing Aria hook adapters and support general
dictation into Ari's text inputs. External insertion on those platforms is not
implemented. macOS Accessibility permissions and Linux's existing X11 hook
requirements are unchanged. Neither platform was physically verified here.

## Actual verification and limits

Before the user stopped visible checks, real Electron 43.4.1 runs verified the
production React composer, recorder/worklet, sandboxed preload IPC, native
uiohook shortcut capture/release, in-app general insertion, and distinct Aria
enqueue routing. Audio input and transcription output were explicitly synthetic;
these checks did not exercise a physical microphone or model inference.

A later Windows run verified general-shortcut insertion of the synthetic text
`dictated` into a uniquely named scratch Notepad document. UI Automation read
the actual before/after document and selection and asserted the exact splice,
collapsed caret, unchanged native foreground HWND, unchanged Aria dispatch count,
and every existing clipboard format and buffer. This assertion passed. The
following focus-restoration check did not pass: its `main.focus()` call had not
proved a real foreground transition, so the expected rejection was not established.
The harness now requires successful native activation and a changed HWND before
testing that rejection, but it was not rerun after visible checks were prohibited.

Final foreground pinning, lifecycle guards, and shortcut-lease corrections were
verified with noninteractive Node tests, typechecks, lint, and the desktop build.
They were not subsequently verified on the user's desktop. The UI fixture is
opt-in and refuses to run without `ARIA_DICTATION_VISIBLE_FIXTURE=1`; it must only
be run with explicit permission. No additional visible or audible checks ran
after the user prohibited them. Physical microphone, final focus-loss UI behavior,
unsupported Windows providers, and macOS/Linux runtime checks remain unverified.

The final Node routing/speech suite passed 377 tests in 25 files. Contracts passed
53 speech-settings tests, and the engine passed 24 SettingsStore tests. Desktop,
contracts, and engine typechecks, ESLint on every changed TypeScript file, and
the production desktop build passed. React emitted `act(...)` warnings in some
component fixtures; there were no test failures. Both fixture environment flags
were cleared in every check process. The manual fixture is excluded by Vitest's
`*.test.{ts,tsx}` globs and the production build's explicit entrypoints; startup
does not import it. Its config is included only for static TypeScript validation.

Local check logs are retained under `apps/desktop/out/dictation-*-final.log`.
These ignored files and the native scratch evidence are not part of the PR.

The speech pipeline uses Electron utility processes and native `transcribe-cpp`;
model discovery/engine setup contain no Python/uv subprocesses or version probes.
Existing engine read retries retry filesystem reads, and widget readiness polling
calls `speech.status` rather than launching a helper. No Python/uv change was
needed in the product.

## Isolation and cleanup

This branch started from fresh `origin/main` at `50ee55d2` in
`D:/Projects/Ari-speech-dictation-routing`. The managed session's inherited
`20409cba` snapshot and the main/startup/other PR worktrees were preserved.
PRs #496/#497 overlap speech controls/recording but their commits were not imported;
their timeout and audio ducking changes remain separate. PRs #498/#499 were
inspected and are unrelated to this routing correction.

No owned Electron processes remained at cleanup. Scratch-launched Notepad PIDs
30968 and 23380 had command lines pointing at this worktree's evidence files and
exited. Exact owned scratch tabs in shared Notepad PID 2480 were closed individually,
including discarding only the exact-path scratch save prompt. All 15 other tabs
checked before that close were preserved. Final inventory found no owned scratch
tabs/processes. Scratch files and `cleanup.json` remain under the ignored
`apps/desktop/out/dictation-evidence` directory as evidence; no user work was removed.
