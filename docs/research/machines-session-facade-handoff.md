# Session facade handoff

2026-11-12, recovery 2. Authoring only in `D:/Projects/Ari-machines-wt/session-rework`.

The first source slice exports `SessionScope`, `sessionViewKey`,
`parseSessionViewKey`, `createSessionClient`, `useSessionClient` and
`SessionClientProvider` from `apps/desktop/src/renderer/src/features/session/session-client.tsx`.
Provider accepts `scope` or an already bound `client`; use outside providers
operates on explicitly local project tools. Remote calls never default to local.
`sessionOperation` maps normal RPC/command names for capability reasons.

Shell can consume `createHostDraftClient(machineId, draftId)` (also exported as
`createSessionDraftClient`) and `HostDraftSelection`/`HostDraftClient` from
`session-draft-client.ts`. Methods: `catalog`, `projects`, `workspaces(projectId)`,
`receipt`, `create(selection)`, `checkCreation`, `stage(scope, files)`,
`firstPrompt(scope,text,attachmentIds)`, `checkPrompt(scope)`. Successful create
returns the structural SessionScope. Shell must durably retain confirmed scope
before staging/sending, freeze selection before create, and keep the original
draft id/receipt scope on uncertainty. Status checks never resend. Existing
remote-client receipt rules are extended to desktop command result schemas.

The route stream seam sends `machines.events` with `desktop:true`; it only
accepts exact `events.desktop.frame` messages after separately negotiating
`events.desktop.subscribe`. Route owner must preserve `machinesExtensions` on
machine.identity and support the desktop stream flag. Missing extension leaves
normal view cached/read-only; legacy mobile frames are not mislabelled as a
complete desktop journal. `scm.diff` maps to `scm.desktop.diff`, but until the host
adds its strict schema the request deliberately fails validation. Host owns that
schema per b4b5b0ed. Remote terminal mappings still require coordinator wiring.

Initial source is committed before heavy verification. SessionView, scoped cache
invalidation, attachments and result-card conversion follow in the next slice.
