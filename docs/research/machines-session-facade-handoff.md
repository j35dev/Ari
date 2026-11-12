# Normal desktop session facade handoff

2026-11-12. Authoring: `D:/Projects/Ari-machines-wt/session-rework`, branch
`machines/session-rework`, preserved source `22a53c69`. Final source/tests are
`c2a9acccc301118f8ebefd003efa5e97fb36d602`; scoped validation uses
`apps/desktop/tsconfig.machines-session.json`.
Host, routes, tools and shell dependencies were consumed through `feat/machines`,
including `4edbeb91`. The final handoff commit follows these source commits.

## Shell consumption

`session-client.tsx` exports `SessionScope`, `sessionViewKey`,
`parseSessionViewKey`, `createSessionClient`, `useSessionClient`,
`SessionClientProvider`, `sessionOperation` and `readHostModelCatalog`.

Local engine IDs keep their keys; the known legacy Aria ID is retained. Remote
keys are canonical `[registryMachineId, wireSessionId]` JSON tuples. Unknown keys
are refused. Names, addresses and repository groups never become scope keys.
`SessionView` accepts explicit scope plus wire ID and reattaches navigation,
child/parent title and activity callbacks to the same host. An inherited remote
scope stays remote when a child wire ID is rendered.

Transcript, journal, composer recovery, review notes, browser picks and seeds
use the view key. Attachment caches include authorization epoch and attachment
ID. Offline/incompatible views retain cached transcript as read-only. Removal,
revocation, identity change and connected project-grant reduction invalidate
watched stores and late writers. User drafts and original receipts survive.

`session-draft-client.ts` exports `createHostDraftClient` (alias
`createSessionDraftClient`), `HostDraftSelection` and `HostDraftClient`. Methods:
`catalog`, `projects`, `workspaces`, `receipt`, `createdScope`, `create`,
`checkCreation`, `stage`, `firstPrompt`, `checkPrompt`.

The approved local draft uses `useSessionStart` only on first Send and returns a
local `SessionScope`. Remote drafts always use the host facade. Project/machine
selection creates no durable session. Shell freezes the exact host, project,
catalog and workspace selection before Send. The facade persists confirmed
creation scope before clearing its original receipt and returns the same scope
across remounts. Confirmed first-prompt state is likewise saved before clearing.
Storage failures retain original receipts. Uncertain creation/prompt never
resends or creates a replacement session; checks only query original status.

## Normal composer and controls

Prompt, human queue, dequeue, text/attachment steer, stop, questions, exact host
approval options, provider switch, effort, permission, title, resume, plan and
turn-diff reads use the finite scoped allowlist. Held/routine/room queue policy
is refused. Host catalogs supply provider/effort choices. Unsupported saved
effort is retained instead of reset to a client default. Remote default changes
are adopted after confirmation. Unknown receipts block new actions, including
Regenerate, and expose Check status with the original key.

The shell-owned Composer input seam uses `useSessionClient` for existing
sessions and `remoteInput` for drafts. Draft paste bytes remain inline; remote
OS paths and speech are refused. The exact normal
`fs.writeTextFile({sessionId,path,content})` call maps to receipted
`pastes.stage({sessionId,text:content})`. Generated client paths grant no write
authority. The adapter returns host `{path,bytesWritten}` and Composer inserts
that path. Normal directory root `.` becomes gateway root `''`.

Unsupported provider setup, session administration, checkpoint undo and
versioned result management never invoke local engine/provider RPC. Normal
surfaces expose reasons and worker reports remain readable. Files/Changes/
Terminal stay coordinator-owned scoped consumers. Root terminal adapters cover
host input, store/grant/epoch and receipt ownership; these files came via root.

## Replay correction

Desktop replay separately negotiates `events.desktop.subscribe` and requests
`machines.events` with `desktop:true`. Full history includes seq zero, bounded
chunks, explicit empty/incomplete terminals and actual live-turn fences. The
adapter validates contiguous chunks and terminal coverage. Resume preserves
the prefix; events newer than the replay barrier own the newer live turn.

Independent review found that the first terminal did not release start state.
Correction `1c7cc31974feee4e6befd3f05707a4553210b4c3` admits subsequent
exact-cursor replay after a terminal while rejecting overlapping starts. A
renderer-only `replayStart` reopens SessionView's barrier, resets sequence
observation, preserves cached history and adopts the next terminal's live-turn
fence without historical notifications. No wire mutation or action retry was
added.

## Verification and remaining integration

All heavy commands used `D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs`
with worker `session-replacement`, below-normal priority, one Vitest worker,
`--no-file-parallelism`, resource gates and the existing dev lease retained.

- Initial regressions: 210 passed in 11 files (normal view/history/provider
  switches, transcript, keep-alive, resume, result cards and host facade/draft/UI).
- Post-reconnect regressions: 34 passed in the four facade/draft/remote-view/
  history files, covering exact-cursor resume, overlap rejection, >2,000 rows,
  unknown receipts, grant-loss disposal and host paste paths.
- Final real remote Composer suite: 7 passed, including real speech suppression,
  paste staging, cached offline/revoked view and reconnect live-turn fencing.
- Scoped ESLint: all 20 assigned source/focused-test paths passed.
- Scoped typecheck passed: `pnpm --filter @ari/desktop exec tsc --noEmit -p
  tsconfig.machines-session.json`; result retained in the scoped log.
- Full desktop typecheck remains blocked by shell-owned test findings at
  `Composer.test.tsx:913` (complex inferred union) and
  `MachineNavigation.test.tsx:71` (repository origin fixture type).

Ignored worktree logs: `.machines-session-focused.log`,
`.machines-session-reconnect.log`, `.machines-session-composer-final.log`,
`.machines-session-lint.log`, `.machines-session-typecheck.log`,
`.machines-session-scoped-typecheck.log`.
Full integrated security, engine/route loopback proofs, screenshots and hardware
validation remain coordinator-owned. No push, PR, live app/settings/profile or
Tailscale Serve changes were made here.
