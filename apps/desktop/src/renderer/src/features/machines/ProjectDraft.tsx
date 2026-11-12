import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { ProjectAgent } from '@ari/contracts/project'
import { projectAgentSchema } from '@ari/contracts/project'
import type { RemoteModelCatalog, RemoteProjectWorkspaces } from '@ari/contracts/remote'
import type { SessionScope } from '../session/session-client'
import { Composer, type ComposerSeed } from '../composer/Composer'
import { readSessionDraftIntent } from '../composer/draft-recovery-store'
import { ModelSelector } from '../composer/ModelSelector'
import { ComposerDock } from '../session/ComposerDock'
import { MachinePicker, type DraftMachineSelection } from './MachinePicker'
import { checkoutChoices, type RepositoryGroup } from './repository-groups'
import { manualEligibility, selectAutoHost, validateSelection, type SelectionHost } from './machine-policy'
import { messageOf } from './remote-client'

/** The session owner's draft facade supplies these narrow operations. */
export interface ProjectDraftClient {
  catalog(): Promise<RemoteModelCatalog>
  workspaces(projectId: string): Promise<RemoteProjectWorkspaces>
  create(input: { draftId: string; projectId: string; title: string; pick: ProjectAgent;
    workspaceToken?: string; workspaceMode?: 'auto' | 'isolated' | 'shared' }): Promise<SessionScope>
  stage(scope: SessionScope, files: File[]): Promise<string[]>
  prompt(scope: SessionScope, input: { draftId: string; text: string; attachmentIds: string[] }): Promise<void>
  checkCreate(draftId: string): Promise<SessionScope | null>
  checkPrompt(draftId: string, scope: SessionScope): Promise<boolean>
}
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), sessionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('remote'), machineId: z.string().min(1), sessionId: z.string().min(1) }).strict(),
])
const attemptSchema = z.object({
  draftId: z.string(), groupId: z.string(), hostId: z.string(), projectId: z.string(), text: z.string(),
  phase: z.enum(['create', 'stage', 'prompt']), scope: scopeSchema.nullable(),
}).strict()
type Attempt = z.infer<typeof attemptSchema>
const attemptKey = (id: string) => `ari.machines.projectDraft.attempt.v1:${id}`
const choiceKey = (id: string) => `ari.machines.projectDraft.choice.v1:${id}`
const choiceSchema = z.object({
  groupId: z.string(), selection: z.object({ mode: z.enum(['manual', 'auto']), hostId: z.string().nullable(), reason: z.string() }),
  checkoutId: z.string().nullable(), workspaceToken: z.string().optional(), workspaceLocked: z.boolean(), pick: projectAgentSchema.nullable(),
})
const readyProvider = (row: RemoteModelCatalog['providers'][number]) =>
  row.available !== false && row.installed !== false && row.authStatus !== 'unauthenticated'

export function ProjectDraft({ draftId, group, hosts, initialHostId, autoEnabled, lastManualHostId,
  clientFor, defaultFor, onRememberHost, onCreated, onClose }: {
  draftId: string
  group: RepositoryGroup
  hosts: SelectionHost[]
  initialHostId?: string
  autoEnabled: boolean
  lastManualHostId?: string
  clientFor: (hostId: string) => ProjectDraftClient
  defaultFor: (hostId: string, projectId: string) => ProjectAgent | null
  onRememberHost: (hostId: string) => void
  onCreated: (scope: SessionScope, seed?: ComposerSeed) => void
  onClose: () => void
}) {
  const [restored] = useState(() => {
    try {
      const raw = localStorage.getItem(attemptKey(draftId))
      if (!raw) return { attempt: null, error: null }
      const attempt = attemptSchema.parse(JSON.parse(raw))
      if (attempt.draftId !== draftId || attempt.groupId !== group.id) throw new Error('Wrong draft scope')
      return { attempt, error: null }
    } catch { return { attempt: null, error: 'This draft receipt cannot be read. Inspect its original host before sending again.' } }
  })
  const [attempt, setAttempt] = useState<Attempt | null>(restored.attempt)
  const [savedChoice] = useState(() => {
    try {
      const raw = localStorage.getItem(choiceKey(draftId))
      const value = raw ? choiceSchema.parse(JSON.parse(raw)) : null
      return value?.groupId === group.id ? value : null
    } catch { return null }
  })
  const attemptRef = useRef(attempt)
  attemptRef.current = attempt
  const [selection, setSelection] = useState<DraftMachineSelection>(() => {
    if (restored.attempt) return { mode: 'manual', hostId: restored.attempt.hostId, reason: 'Original submission — check its status.' }
    if (savedChoice) return savedChoice.selection
    if (!initialHostId && autoEnabled) return { mode: 'auto', ...selectAutoHost(hosts) }
    const remembered = hosts.find((host) => host.id === lastManualHostId && manualEligibility(host) === null)
    const hostId = initialHostId ?? remembered?.id ?? 'local'
    return { mode: 'manual', hostId, reason: `${hosts.find((host) => host.id === hostId)?.name ?? 'This PC'} runs this draft.` }
  })
  const selectedHost = hosts.find((host) => host.id === selection.hostId)
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  const choices = checkoutChoices(group, selection.hostId ?? '')
  const [checkoutId, setCheckoutId] = useState<string | null>(restored.attempt?.projectId ?? savedChoice?.checkoutId ?? null)
  const projectId = checkoutId && choices.some((checkout) => checkout.projectId === checkoutId)
    ? checkoutId : choices.length === 1 ? choices[0]!.projectId : null
  const [catalog, setCatalog] = useState<RemoteModelCatalog | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteProjectWorkspaces | null>(null)
  const [workspaceToken, setWorkspaceToken] = useState<string | undefined>(savedChoice?.workspaceToken)
  const [workspaceLocked, setWorkspaceLocked] = useState(savedChoice?.workspaceLocked ?? false)
  const [pick, setPick] = useState<ProjectAgent | null>(savedChoice?.pick ?? null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [failure, setFailure] = useState<string | null>(restored.error)
  const canvasRef = useRef<HTMLDivElement>(null)
  const client = useMemo(() => selection.hostId ? clientFor(selection.hostId) : null, [clientFor, selection.hostId])
  const restoringChoice = useRef(true)
  const locked = workspaceLocked || attempt !== null || restored.error !== null
  const provider = catalog?.providers.find((row) => row.driverKind === pick?.driverKind)
  const model = provider?.models.find((row) => row.id === pick?.modelId || row.aliases?.includes(pick?.modelId ?? ''))
  const efforts = model?.efforts ?? provider?.efforts ?? []
  const modes = provider?.modes ?? []
  const pickReason = !pick ? 'Choose an agent and model on this machine.' :
    !provider || !readyProvider(provider) ? provider?.reason ?? 'This agent is unavailable on the selected machine.' :
    pick.modelId !== null && !model ? 'The saved model is unavailable. Choose a model from this host.' :
    pick.effort !== null && !efforts.some((effort) => effort.id === pick.effort) ? 'The saved effort is unavailable on this host.' :
    modes.length > 0 && !modes.some((mode) => mode.ariMode === pick.permissionMode) ? 'The saved permission mode is unavailable on this host.' : null

  useEffect(() => {
    let alive = true
    setCatalog(null)
    if (!client || !selectedHost?.connected || !selectedHost.compatible) return
    void client.catalog().then((next) => { if (alive) setCatalog(next) }).catch((error) => { if (alive) setFailure(messageOf(error)) })
    return () => { alive = false }
  }, [client, selectedHost?.connected, selectedHost?.compatible])
  useEffect(() => {
    let alive = true
    setWorkspaces(null)
    if (!workspaceLocked) setWorkspaceToken(undefined)
    if (!restoringChoice.current || !savedChoice) setPick(selection.hostId && projectId ? defaultFor(selection.hostId, projectId) : null)
    restoringChoice.current = false
    if (!client || !projectId || attemptRef.current) return
    void client.workspaces(projectId).then((next) => { if (alive) setWorkspaces(next) }).catch((error) => { if (alive) setFailure(messageOf(error)) })
    return () => { alive = false }
  }, [client, projectId, selection.hostId, defaultFor])
  useEffect(() => {
    if (!pick && catalog?.defaults?.driverKind && projectId && !attemptRef.current) {
      setPick({ driverKind: catalog.defaults.driverKind, modelId: catalog.defaults.modelId,
        permissionMode: catalog.defaults.permissionMode, effort: null })
    }
  }, [catalog, pick, projectId])
  useEffect(() => {
    try { localStorage.setItem(choiceKey(draftId), JSON.stringify({ groupId: group.id, selection,
      checkoutId: projectId, workspaceToken, workspaceLocked, pick })) } catch { /* The mutation receipt is required separately. */ }
  }, [draftId, group.id, selection, projectId, workspaceToken, workspaceLocked, pick])

  const rememberAttempt = (next: Attempt) => {
    // Persist before the actual effect; a lost renderer never authorizes another create.
    localStorage.setItem(attemptKey(draftId), JSON.stringify(next))
    attemptRef.current = next
    setAttempt(next)
  }
  const verifyScope = (scope: SessionScope, hostId: string) => {
    scopeSchema.parse(scope)
    if (hostId === 'local' ? scope.kind !== 'local' : scope.kind !== 'remote' || scope.machineId !== hostId)
      throw new Error('The creation result belongs to a different machine. Check the original submission.')
  }
  const send = (text: string, files: File[]) => {
    if (pendingRef.current || attemptRef.current || restored.error) return false
    const reason = validateSelection(selectedHost, selection.mode === 'auto') ?? pickReason ??
      (!projectId ? 'Choose the checkout on this machine.' : null)
    if (reason || !client || !pick || !projectId || !selection.hostId) { setFailure(reason); return false }
    const hostId = selection.hostId
    const frozenPick = { ...pick }
    const option = workspaces?.options.find((item) => item.token === workspaceToken)
    const started: Attempt = { draftId, groupId: group.id, hostId, projectId, text, phase: 'create', scope: null }
    try { rememberAttempt(started) } catch { setFailure('Save the draft receipt before sending. Free browser storage and try again.'); return false }
    pendingRef.current = true; setPending(true); setFailure(null)
    void (async () => {
      try {
        const scope = await client.create({ draftId, projectId, title: text.trim().slice(0, 120) || 'New session',
          pick: frozenPick, workspaceToken, workspaceMode: option?.workspaceMode ?? 'auto' })
        verifyScope(scope, hostId)
        rememberAttempt({ ...started, scope, phase: 'stage' })
        const stageReason = validateSelection(hostsRef.current.find((host) => host.id === hostId), selection.mode === 'auto')
        if (stageReason) throw new Error(stageReason)
        const attachmentIds = files.length > 0 ? await client.stage(scope, files) : []
        const dispatchReason = validateSelection(hostsRef.current.find((host) => host.id === hostId), selection.mode === 'auto')
        if (dispatchReason) throw new Error(dispatchReason)
        rememberAttempt({ ...started, scope, phase: 'prompt' })
        await client.prompt(scope, { draftId, text, attachmentIds })
        localStorage.removeItem(attemptKey(draftId))
        onCreated(scope)
      } catch (error) { setFailure(`${messageOf(error)} Check the original submission; it will not be sent again.`) }
      finally { pendingRef.current = false; setPending(false) }
    })()
    // Keep text and image bytes in the normal Composer until confirmed handoff.
    return false
  }
  const check = async () => {
    const original = attemptRef.current
    if (!original || !client || pendingRef.current) return
    pendingRef.current = true; setPending(true)
    try {
      if (original.phase === 'create') {
        const scope = await client.checkCreate(draftId)
        if (!scope) { setFailure('The creation outcome is still unknown. Reconnect and check again.'); return }
        verifyScope(scope, original.hostId)
        rememberAttempt({ ...original, scope, phase: 'stage' })
        onCreated(scope, { text: original.text, nonce: Date.now(),
          images: readSessionDraftIntent(`project-draft:${draftId}`).images })
      } else if (original.phase === 'prompt' && original.scope) {
        if (await client.checkPrompt(draftId, original.scope)) {
          localStorage.removeItem(attemptKey(draftId)); onCreated(original.scope)
        } else setFailure('The first prompt outcome is still unknown. This draft remains on its original machine.')
      } else setFailure('The attachment outcome is uncertain. Open the created session to inspect its original receipt.')
    } catch (error) { setFailure(messageOf(error)) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const openCreated = (scope: SessionScope, text: string) => onCreated(scope, {
    text, nonce: Date.now(), images: readSessionDraftIntent(`project-draft:${draftId}`).images,
  })
  return <div className="flex h-full min-h-0 flex-col" ref={canvasRef}>
    <div className="ari-chat-column flex items-center justify-between py-3 text-xs text-fg-muted">
      <span>{group.name}{group.label ? ` · ${group.label}` : ''}</span>
      <button type="button" onClick={onClose} className="rounded px-2 py-1 hover:bg-surface-2">Close draft</button>
    </div>
    <div className="min-h-0 flex-1" />
    <ComposerDock centered canvasRef={canvasRef} reducedMotion={false} onStart={(prompt) => send(prompt, [])}>
      {(failure || attempt) && <div className="mb-3 rounded-md border border-warning/30 bg-surface-1 p-3 text-xs">
        <p role="status">{failure ?? 'Check the original submission before continuing.'}</p>
        {attempt && !pending && <button type="button" className="mt-2 rounded border border-border px-2 py-1" onClick={() => void check()}>Check original submission</button>}
        {attempt?.scope && attempt.phase === 'stage' && <button type="button" disabled={pending} className="ml-2 rounded border border-border px-2 py-1" onClick={() => openCreated(attempt.scope!, attempt.text)}>Open created session</button>}
      </div>}
      <Composer sessionId={`project-draft:${draftId}`} draftOnly centered disabled={pending || attempt !== null || restored.error !== null}
        sendPending={pending} onSend={send} placeholder="Describe what you want to do in this project…"
        leading={<>
          <ModelSelector driverKind={pick?.driverKind ?? 'ari-core'} modelId={pick?.modelId ?? null} hostCatalog={catalog}
            disabled={attempt !== null || pending} onChange={(next) => { if (!attemptRef.current) setPick({ ...next, effort: null, permissionMode: catalog?.defaults?.permissionMode ?? 'ask' }) }} />
          {pick && <select aria-label="Reasoning effort" disabled={attempt !== null || pending} value={pick.effort ?? ''}
            onChange={(event) => setPick({ ...pick, effort: event.target.value || null })} className="bg-transparent text-xs text-fg-muted">
            <option value="">Agent default</option>{efforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
          </select>}
          {pick && <select aria-label="Permission mode" disabled={attempt !== null || pending} value={pick.permissionMode}
            onChange={(event) => setPick({ ...pick, permissionMode: event.target.value as ProjectAgent['permissionMode'] })}
            className="bg-transparent text-xs text-fg-muted">
            {modes.length > 0 ? modes.map((mode) => <option key={mode.id} value={mode.ariMode}>{mode.label}</option>) :
              <option value={pick.permissionMode}>{pick.permissionMode}</option>}
          </select>}
        </>}
        belowControls={<>
          <MachinePicker hosts={hosts} selection={selection} locked={locked} onSelect={(id) => {
            if (locked) return
            setCheckoutId(null); setPick(null); setWorkspaceToken(undefined); setFailure(null)
            if (id === 'auto') setSelection({ mode: 'auto', ...selectAutoHost(hosts) })
            else { setSelection({ mode: 'manual', hostId: id, reason: `${hosts.find((host) => host.id === id)?.name ?? id} runs this draft.` }); onRememberHost(id) }
          }} />
          {choices.length > 1 && <label className="mt-2 flex items-center gap-2 text-xs text-fg-muted">Checkout
            <select aria-label="Project checkout" value={projectId ?? ''} disabled={locked} onChange={(event) => setCheckoutId(event.target.value || null)}
              className="min-w-0 rounded border border-border bg-surface-1 px-2 py-1"><option value="">Choose a checkout</option>
              {choices.map((checkout) => <option key={checkout.projectId} value={checkout.projectId}>{checkout.checkoutLabel}</option>)}
            </select></label>}
          {workspaces && <label className="mt-2 flex items-center gap-2 text-xs text-fg-muted">Workspace
            <select aria-label="Project workspace" value={workspaceToken ?? ''} disabled={locked} onChange={(event) => {
              const token = event.target.value || undefined; setWorkspaceToken(token)
              const kind = workspaces.options.find((option) => option.token === token)?.kind
              if (kind === 'branch' || kind === 'worktree') setWorkspaceLocked(true)
            }} className="rounded border border-border bg-surface-1 px-2 py-1"><option value="">Automatic workspace isolation</option>
              {workspaces.options.map((option) => <option key={option.token} value={option.token}>{option.label}</option>)}
            </select></label>}
          {!attempt && pickReason && <p className="mt-2 text-xs text-fg-subtle" role="status">{pickReason}</p>}
        </>} />
    </ComposerDock>
  </div>
}
