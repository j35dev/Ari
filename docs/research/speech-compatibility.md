# Combined dictation, timeout, and audio ducking

This compatibility branch starts at PR #503's exact head
`b0ea9accab05c944d3fd80f73b46b184083c5e98` and targets its
`fix/speech-dictation-routing` branch. It cherry-picks only the authorized inputs:

| Input                                       | Original commit                            | Local cherry-pick |
| ------------------------------------------- | ------------------------------------------ | ----------------- |
| #496: long capture and inference keep-alive | `e346fdff5cf448de8155d166d80551f63294624b` | `c2b891db`        |
| #497: audio ducking                         | `67fe7e9276988128ad77054c99931384ef85bacd` | `78527872`        |

Upstream main remains `50ee55d273ab1a0240111638dba05c894ce2d3d1`.
No main merge, original draft-head change, dependency-manifest change, release,
or running-host update is part of this work. All changes live in
`D:/Projects/Ari-speech-compatibility`; original worktrees and artifacts remain retained.

## Conflict resolutions and behavior

- SpeechButton keeps #503's captured target, generation checks, capture lease,
  cleanup, and pending-Enter suppression. #496's lifecycle tests were adapted to
  that API instead of restoring the former live transcript callback.
- The recorder retains #496's unlimited capture and #497's first-sample readiness,
  stopped, and unexpected-error callbacks. The shared test microphone supports
  both long PCM checks and event failure/cleanup checks. Service/RPC recording
  limits and widget recording/transcription deadlines remain removed. The speech
  service still applies its bounded audio/model-aware budget after work dequeues;
  queued work is not charged for its wait, and worker keep-alive behavior remains.
- Both global shortcuts use the same recording widget and ducking lifecycle.
  Ducking begins only after first samples for the current listening hold. Release
  restores audio before transcription while the target lease remains held through
  insertion. Cancellation, capture failure, disable, crash, close, and disposal
  clear ownership. Stale callbacks cannot lower audio or restore a newer capture.
  Toggling ducking restores/reapplies volume without resetting the hook or target.
- Composer microphones retain their existing audio behavior; no composer ducking
  capability was added. They now consume the recorder's unexpected-error callback
  to release the captured target/lease immediately. Generation checks discard a
  cancelled recorder's late error instead of cancelling a newer capture.
- Settings retain both shortcut bindings, migrations and full mutual/OS/Ari
  conflicts, plus #497's `duckAudio` preference. Legacy migration and later binding
  edits preserve the model and an explicit ducking opt-out. Settings capture-lease
  release rejection handling remains intact.
- Build inputs include the speech, dictation, and audio-ducking workers. Manual
  native fixture entrypoints are not imported by startup or default tests/build.

Aria's shortcut retains its enqueue/send intent. General and composer dictation
insert into their captured unchanged draft/caret without submitting. #503's
external target, focus-loss, cancellation, and clipboard-preservation behavior is
preserved; no external-input implementation was changed in this compatibility batch.

## Verification and limits

Joint headless tests cover ten-minute widget/composer holds with retained leases,
competing capture rejection, release through transcription/insertion, preference
changes, cancellation, failure, stale targets/callbacks, disposal, balanced recorder
events, timer cleanup, and settings migration/conflicts. Existing suites cover
worker keep-alive and budgets, ducking ownership/restoration/journal recovery,
user volume changes, platform adapter stubs, and real controlled Composer draft
insertion in jsdom. Check commands, exit codes, counts, and exact changed files are
retained in the ignored `apps/desktop/out/compatibility-checks.json` manifest and
adjacent logs. The final combined suite passed 454 desktop tests in 32 files,
54 contracts speech-setting tests, and 24 engine SettingsStore tests. Desktop,
contracts, and engine typechecks, lint on all changed TypeScript files, and the
production desktop build passed. The build emitted all three worker entrypoints.
React's existing component fixtures emitted act warnings without test failures.

The dependency setup used `pnpm install --offline --frozen-lockfile --ignore-scripts`
with the parent's explicit approval. It reused cached lockfile dependencies,
downloaded nothing, ran no lifecycle scripts, and created no borrowed junctions.
The new dependency tree is retained with this unmerged worktree.

Every check process used `login=false` and cleared
`ARIA_DICTATION_VISIBLE_FIXTURE` and `ARIA_DICTATION_NATIVE_ONLY`. No Electron,
Notepad/editor fixture, desktop input, native audio helper, physical microphone,
audible speech, Python/uv helper, or browser-use check ran for this batch.

Prior native evidence in [dictation routing](dictation-routing.md) and
[audio ducking research](handy-audio-ducking.md) belongs to the original #503/#497
work. It is not native verification of this combined head. Physical microphone,
final native focus-loss/insertion, actual combined audio restoration, packaged
runtime, macOS, and Linux playback remain unverified. Windows external insertion
requires an editable accessible TextPattern; macOS/Linux external insertion is
unavailable. Ducking supports Windows and Linux's PulseAudio/PipeWire `pactl`
adapter; macOS leaves audio unchanged. The original journal/identity and bounded
recovery limitations remain, including unavailable devices/services preventing
immediate restoration without applying a stale baseline to a different stream.

This PR depends on #503 and contains reconciled #496/#497 changes. If those drafts
land independently, reconcile the resulting overlap rather than applying these
changes twice. No other open draft or capability change was imported.
