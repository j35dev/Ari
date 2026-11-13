import { DEFAULT_PERMISSION_MODE } from '@ari/contracts/common'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { ProjectAgent } from '@ari/contracts/project'
import { projectAgentSchema } from '@ari/contracts/project'
import type { RemoteModelCatalog, RemoteProjectWorkspaces } from '@ari/contracts/remote'
import type { SessionScope } from '../session/session-client'
import { Composer, type ComposerSeed } from '../composer/Composer'
import { readSessionDraftIntent } from '../composer/draft-recovery-store'
import type { LastPick } from '../composer/last-pick'
import { ModelSelector } from '../composer/ModelSelector'
import { ComposerDock } from '../session/ComposerDock'
import { DitherScene } from '../scene/DitherScene'
import { MachinePicker, type DraftMachineSelection } from './MachinePicker'
import { FolderOpen, X } from 'lucide-react'
import { iconButton, outlineButton } from '../../lib/recipes'
import { TextPicker, sentenceCase } from '../session/TextPicker'
import { ModeMark } from '../session/mode-mark'
import { EffortGlyph, effortLevels } from '../session/effort-level'
import { checkoutChoices, type RepositoryGroup } from './repository-groups'
import {
  manualEligibility,
  selectAutoHost,
  validateSelection,
  type SelectionHost,
} from './machine-policy'
import { messageOf } from './remote-client'

/** The session owner's draft facade supplies these narrow operations. */
export interface ProjectDraftClient {
  catalog(): Promise<RemoteModelCatalog>
  workspaces(projectId: string): Promise<RemoteProjectWorkspaces>
  create(input: {
    draftId: string
    projectId: string
    title: string
    pick: ProjectAgent
    workspaceToken?: string
    workspaceMode?: 'auto' | 'isolated' | 'shared'
  }): Promise<SessionScope>
  stage(scope: SessionScope, files: File[]): Promise<string[]>
  prompt(
    scope: SessionScope,
    input: { draftId: string; text: string; attachmentIds: string[] },
  ): Promise<void>
  checkCreate(draftId: string): Promise<SessionScope | null>
  checkPrompt(draftId: string, scope: SessionScope): Promise<boolean>
}
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), sessionId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('remote'),
      machineId: z.string().min(1),
      sessionId: z.string().min(1),
    })
    .strict(),
])
const attemptSchema = z
  .object({
    draftId: z.string(),
    groupId: z.string(),
    hostId: z.string(),
    projectId: z.string(),
    text: z.string(),
    phase: z.enum(['create', 'stage', 'prompt']),
    scope: scopeSchema.nullable(),
  })
  .strict()
type Attempt = z.infer<typeof attemptSchema>
const attemptKey = (id: string) => `ari.machines.projectDraft.attempt.v1:${id}`
const choiceKey = (id: string) => `ari.machines.projectDraft.choice.v1:${id}`
const choiceSchema = z.object({
  groupId: z.string(),
  selection: z.object({
    mode: z.enum(['manual', 'auto']),
    hostId: z.string().nullable(),
    reason: z.string(),
  }),
  checkoutId: z.string().nullable(),
  workspaceToken: z.string().optional(),
  workspaceLocked: z.boolean(),
  pick: projectAgentSchema.nullable(),
})
/** Ari's own modes, offered when the agent names none of its own. */
const DEFAULT_MODES = (
  [
    ['ask', 'Ask', 'Confirm every edit and command'],
    ['allow-edits', 'Edits', 'Auto-approve edits; ask before commands'],
    ['full', 'Full auto', 'Approve everything automatically'],
  ] as const
).map(([value, label, hint]) => ({ value, label, hint, mark: <ModeMark mode={value} /> }))
const readyProvider = (row: RemoteModelCatalog['providers'][number]) =>
  row.available !== false && row.installed !== false && row.authStatus !== 'unauthenticated'

export function ProjectDraft({
  draftId,
  group,
  hosts,
  initialHostId,
  autoEnabled,
  lastManualHostId,
  clientFor,
  defaultFor,
  refreshHosts,
  autoReady = true,
  onRememberHost,
  onPick,
  onCreated,
  onClose,
}: {
  draftId: string
  group: RepositoryGroup
  hosts: SelectionHost[]
  initialHostId?: string
  autoEnabled: boolean
  autoReady?: boolean
  refreshHosts: (hostIds: readonly string[]) => Promise<SelectionHost[]>
  lastManualHostId?: string
  clientFor: (hostId: string) => ProjectDraftClient
  defaultFor: (hostId: string, projectId: string) => ProjectAgent | null
  onRememberHost: (hostId: string) => void
  /** A model or reasoning level chosen here becomes the next session's start. */
  onPick?: (change: Partial<LastPick>) => void
  onCreated: (scope: SessionScope, seed?: ComposerSeed) => void
  onClose: () => void
}) {
  const [restored] = useState(() => {
    try {
      const raw = localStorage.getItem(attemptKey(draftId))
      if (!raw) return { attempt: null, error: null }
      const attempt = attemptSchema.parse(JSON.parse(raw))
      if (attempt.draftId !== draftId || attempt.groupId !== group.id)
        throw new Error('Wrong draft scope')
      return { attempt, error: null }
    } catch {
      return {
        attempt: null,
        error: 'This draft receipt cannot be read. Inspect its original host before sending again.',
      }
    }
  })
  const [attempt, setAttempt] = useState<Attempt | null>(restored.attempt)
  const [savedChoice] = useState(() => {
    try {
      const raw = localStorage.getItem(choiceKey(draftId))
      const value = raw ? choiceSchema.parse(JSON.parse(raw)) : null
      return value?.groupId === group.id ? value : null
    } catch {
      return null
    }
  })
  const attemptRef = useRef(attempt)
  attemptRef.current = attempt
  const [selection, setSelection] = useState<DraftMachineSelection>(() => {
    if (restored.attempt)
      return {
        mode: 'manual',
        hostId: restored.attempt.hostId,
        reason: 'Original submission — check its status.',
      }
    if (savedChoice)
      return savedChoice.selection.hostId !== null
        ? savedChoice.selection
        : {
            ...savedChoice.selection,
            reason: 'Select Auto again for fresh resources, or choose a machine manually.',
          }
    if (!initialHostId && autoEnabled)
      return { mode: 'auto', hostId: null, reason: 'Checking fresh machine resources…' }
    const remembered = hosts.find(
      (host) => host.id === lastManualHostId && manualEligibility(host) === null,
    )
    const hostId = initialHostId ?? remembered?.id ?? 'local'
    return {
      mode: 'manual',
      hostId,
      reason: `${hosts.find((host) => host.id === hostId)?.name ?? 'This PC'} runs this draft.`,
    }
  })
  const selectedHost = hosts.find((host) => host.id === selection.hostId)
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  const choices = checkoutChoices(group, selection.hostId ?? '')
  const [checkoutId, setCheckoutId] = useState<string | null>(
    restored.attempt?.projectId ?? savedChoice?.checkoutId ?? null,
  )
  const projectId =
    checkoutId && choices.some((checkout) => checkout.projectId === checkoutId)
      ? checkoutId
      : choices.length === 1
        ? choices[0]!.projectId
        : null
  const [catalog, setCatalog] = useState<RemoteModelCatalog | null>(null)
  const [workspaces, setWorkspaces] = useState<RemoteProjectWorkspaces | null>(null)
  const [workspaceToken, setWorkspaceToken] = useState<string | undefined>(
    savedChoice?.workspaceToken,
  )
  const [workspaceLocked, setWorkspaceLocked] = useState(savedChoice?.workspaceLocked ?? false)
  const [pick, setPick] = useState<ProjectAgent | null>(savedChoice?.pick ?? null)
  // An agent can name several of its modes for one Ari level (Auto and Bypass
  // are both full). The level is what is saved; this remembers which name was
  // picked, so exactly one row is ticked.
  const [nativeModeId, setNativeModeId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [autoSampling, setAutoSampling] = useState(false)
  const pendingRef = useRef(false)
  const autoGeneration = useRef(0)
  const defaultAutoHandled = useRef(
    Boolean(initialHostId || restored.attempt || savedChoice || restored.error),
  )
  useEffect(
    () => () => {
      autoGeneration.current++
    },
    [],
  )
  const [failure, setFailure] = useState<string | null>(restored.error)
  const canvasRef = useRef<HTMLDivElement>(null)
  const client = useMemo(
    () => (selection.hostId ? clientFor(selection.hostId) : null),
    [clientFor, selection.hostId],
  )
  const restoringChoice = useRef(true)
  const locked = workspaceLocked || attempt !== null || restored.error !== null
  const provider = catalog?.providers.find((row) => row.driverKind === pick?.driverKind)
  const model = provider?.models.find(
    (row) => row.id === pick?.modelId || row.aliases?.includes(pick?.modelId ?? ''),
  )
  const efforts = model?.efforts ?? provider?.efforts ?? []
  const modes = provider?.modes ?? []
  const pickReason = !pick
    ? 'Choose an agent and model on this machine.'
    : !provider || !readyProvider(provider)
      ? (provider?.reason ?? 'This agent is unavailable on the selected machine.')
      : pick.modelId !== null && !model
        ? 'The saved model is unavailable. Choose a model from this host.'
        : pick.effort !== null && !efforts.some((effort) => effort.id === pick.effort)
          ? 'The saved effort is unavailable on this host.'
          : modes.length > 0 && !modes.some((mode) => mode.ariMode === pick.permissionMode)
            ? 'The saved permission mode is unavailable on this host.'
            : null

  // Only This PC's picks are remembered, as in a session: a remote host's
  // models are not this machine's preference.
  const rememberPick = (change: Partial<LastPick>) => {
    if (selection.hostId === 'local') onPick?.(change)
  }

  const chooseAuto = useCallback(() => {
    const generation = ++autoGeneration.current
    setCheckoutId(null)
    setPick(null)
    setWorkspaceToken(undefined)
    setFailure(null)
    setAutoSampling(true)
    setSelection({ mode: 'auto', hostId: null, reason: 'Checking fresh machine resources…' })
    const candidates = hostsRef.current.filter(
      (host) => host.preference !== 'manual-only' && manualEligibility(host) === null,
    )
    void refreshHosts(candidates.map((host) => host.id))
      .then((fresh) => {
        if (autoGeneration.current === generation)
          setSelection({
            mode: 'auto',
            ...selectAutoHost(
              fresh.filter((host) => candidates.some((candidate) => candidate.id === host.id)),
            ),
          })
      })
      .catch(() => {
        if (autoGeneration.current === generation)
          setSelection({
            mode: 'auto',
            hostId: null,
            reason: 'Fresh CPU and memory data required — select a machine manually.',
          })
      })
      .finally(() => {
        if (autoGeneration.current === generation) setAutoSampling(false)
      })
  }, [refreshHosts])
  useEffect(() => {
    if (workspaceLocked || attempt !== null) defaultAutoHandled.current = true
    if (!defaultAutoHandled.current && autoEnabled && autoReady) {
      defaultAutoHandled.current = true
      chooseAuto()
    }
  }, [autoEnabled, autoReady, chooseAuto, workspaceLocked, attempt])

  useEffect(() => {
    let alive = true
    setCatalog(null)
    if (!client || !selectedHost?.connected || !selectedHost.compatible) return
    void client
      .catalog()
      .then((next) => {
        if (alive) setCatalog(next)
      })
      .catch((error) => {
        if (alive) setFailure(messageOf(error))
      })
    return () => {
      alive = false
    }
  }, [client, selectedHost?.connected, selectedHost?.compatible])
  useEffect(() => {
    let alive = true
    setWorkspaces(null)
    if (!workspaceLocked) setWorkspaceToken(undefined)
    if (!restoringChoice.current || !savedChoice)
      setPick(selection.hostId && projectId ? defaultFor(selection.hostId, projectId) : null)
    restoringChoice.current = false
    if (!client || !projectId || attemptRef.current) return
    void client
      .workspaces(projectId)
      .then((next) => {
        if (alive) setWorkspaces(next)
      })
      .catch((error) => {
        if (alive) setFailure(messageOf(error))
      })
    return () => {
      alive = false
    }
  }, [client, projectId, selection.hostId, defaultFor])
  useEffect(() => {
    if (!pick && catalog?.defaults?.driverKind && projectId && !attemptRef.current) {
      setPick({
        driverKind: catalog.defaults.driverKind,
        modelId: catalog.defaults.modelId,
        permissionMode: catalog.defaults.permissionMode,
        effort: null,
      })
    }
  }, [catalog, pick, projectId])
  useEffect(() => {
    try {
      localStorage.setItem(
        choiceKey(draftId),
        JSON.stringify({
          groupId: group.id,
          selection,
          checkoutId: projectId,
          workspaceToken,
          workspaceLocked,
          pick,
        }),
      )
    } catch {
      /* The mutation receipt is required separately. */
    }
  }, [draftId, group.id, selection, projectId, workspaceToken, workspaceLocked, pick])

  const rememberAttempt = (next: Attempt) => {
    // Persist before the actual effect; a lost renderer never authorizes another create.
    localStorage.setItem(attemptKey(draftId), JSON.stringify(next))
    attemptRef.current = next
    setAttempt(next)
  }
  const verifyScope = (scope: SessionScope, hostId: string) => {
    scopeSchema.parse(scope)
    if (
      hostId === 'local'
        ? scope.kind !== 'local'
        : scope.kind !== 'remote' || scope.machineId !== hostId
    )
      throw new Error(
        'The creation result belongs to a different machine. Check the original submission.',
      )
  }
  const send = (text: string, files: File[]) => {
    if (pendingRef.current || autoSampling || attemptRef.current || restored.error) return false
    const reason =
      validateSelection(selectedHost, false) ??
      pickReason ??
      (!projectId ? 'Choose the checkout on this machine.' : null)
    if (reason || !client || !pick || !projectId || !selection.hostId) {
      setFailure(reason)
      return false
    }
    const hostId = selection.hostId
    const frozenPick = { ...pick }
    const option = workspaces?.options.find((item) => item.token === workspaceToken)
    const started: Attempt = {
      draftId,
      groupId: group.id,
      hostId,
      projectId,
      text,
      phase: 'create',
      scope: null,
    }
    pendingRef.current = true
    setPending(true)
    setFailure(null)
    void (async () => {
      try {
        // The original Auto host alone is re-sampled. Refusal precedes any durable effect.
        const freshHost =
          selection.mode === 'auto'
            ? (await refreshHosts([hostId])).find((host) => host.id === hostId)
            : selectedHost
        const currentHost = () => {
          const current = hostsRef.current.find((host) => host.id === hostId)
          return current && { ...current, resources: freshHost?.resources ?? null }
        }
        const beforeCreate = validateSelection(currentHost(), selection.mode === 'auto')
        if (beforeCreate) {
          setFailure(beforeCreate)
          return
        }
        try {
          rememberAttempt(started)
        } catch {
          setFailure('Save the draft receipt before sending. Free browser storage and try again.')
          return
        }
        const scope = await client.create({
          draftId,
          projectId,
          title: text.trim().slice(0, 120) || 'New session',
          pick: frozenPick,
          workspaceToken,
          workspaceMode: option?.workspaceMode ?? 'auto',
        })
        verifyScope(scope, hostId)
        rememberAttempt({ ...started, scope, phase: 'stage' })
        const stageReason = validateSelection(currentHost(), selection.mode === 'auto')
        if (stageReason) throw new Error(stageReason)
        const attachmentIds = files.length > 0 ? await client.stage(scope, files) : []
        const dispatchReason = validateSelection(currentHost(), selection.mode === 'auto')
        if (dispatchReason) throw new Error(dispatchReason)
        rememberAttempt({ ...started, scope, phase: 'prompt' })
        await client.prompt(scope, { draftId, text, attachmentIds })
        localStorage.removeItem(attemptKey(draftId))
        onCreated(scope)
      } catch (error) {
        setFailure(
          attemptRef.current
            ? `${messageOf(error)} Check the original submission; it will not be sent again.`
            : `${messageOf(error)} Select a machine manually.`,
        )
      } finally {
        pendingRef.current = false
        setPending(false)
      }
    })()
    // Keep text and image bytes in the normal Composer until confirmed handoff.
    return false
  }
  const check = async () => {
    const original = attemptRef.current
    if (!original || !client || pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      if (original.phase === 'create') {
        const scope = await client.checkCreate(draftId)
        if (!scope) {
          setFailure('The creation outcome is still unknown. Reconnect and check again.')
          return
        }
        verifyScope(scope, original.hostId)
        rememberAttempt({ ...original, scope, phase: 'stage' })
        onCreated(scope, {
          text: original.text,
          nonce: Date.now(),
          images: readSessionDraftIntent(`project-draft:${draftId}`).images,
        })
      } else if (original.phase === 'prompt' && original.scope) {
        if (await client.checkPrompt(draftId, original.scope)) {
          localStorage.removeItem(attemptKey(draftId))
          onCreated(original.scope)
        } else
          setFailure(
            'The first prompt outcome is still unknown. This draft remains on its original machine.',
          )
      } else
        setFailure(
          'The attachment outcome is uncertain. Open the created session to inspect its original receipt.',
        )
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const openCreated = (scope: SessionScope, text: string) =>
    onCreated(scope, {
      text,
      nonce: Date.now(),
      images: readSessionDraftIntent(`project-draft:${draftId}`).images,
    })
  return (
    <div
      className="ari-session-canvas relative isolate flex h-full min-h-0 flex-col"
      ref={canvasRef}
    >
      {/* The same scene as any empty session: a draft is one, before it is sent. */}
      <DitherScene kind="session" className="ari-session-scene" />
      <div className="ari-chat-column relative flex h-11 shrink-0 items-center justify-between gap-3 text-[13px] text-fg-subtle">
        <span className="flex min-w-0 items-center gap-1.5">
          <FolderOpen size={14} strokeWidth={1.7} aria-hidden className="shrink-0" />
          <span className="truncate">
            {group.name}
            {group.label ? ` · ${group.label}` : ''}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close draft"
          title="Close draft"
          className={iconButton}
        >
          <X size={16} strokeWidth={1.7} aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1" />
      <ComposerDock
        centered
        canvasRef={canvasRef}
        reducedMotion={false}
        onStart={(prompt) => send(prompt, [])}
      >
        {(failure || attempt) && (
          <div className="mb-3 flex items-start gap-3 rounded-xl border border-border bg-surface-1 px-3.5 py-3">
            <span aria-hidden className="ari-status mt-[3px]" data-status="attention" />
            <div className="min-w-0 flex-1">
              <p role="status" className="text-[13px] text-fg">
                {failure ?? 'Check the original submission before continuing.'}
              </p>
              {(attempt && !pending) || (attempt?.scope && attempt.phase === 'stage') ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {attempt && !pending && (
                    <button type="button" className={outlineButton} onClick={() => void check()}>
                      Check original submission
                    </button>
                  )}
                  {attempt?.scope && attempt.phase === 'stage' && (
                    <button
                      type="button"
                      disabled={pending}
                      className={outlineButton}
                      onClick={() => openCreated(attempt.scope!, attempt.text)}
                    >
                      Open created session
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}
        <Composer
          sessionId={`project-draft:${draftId}`}
          draftOnly
          remoteInput={selection.hostId !== 'local'}
          centered
          disabled={pending || autoSampling || attempt !== null || restored.error !== null}
          sendPending={pending}
          onSend={send}
          placeholder="Describe what you want to do in this project…"
          leading={
            <>
              <ModelSelector
                driverKind={pick?.driverKind ?? 'ari-core'}
                modelId={pick?.modelId ?? null}
                hostCatalog={catalog}
                disabled={attempt !== null || pending}
                onChange={(next) => {
                  if (attemptRef.current) return
                  // The reasoning level carries over within one agent, as in a
                  // session, when the new model offers it; another agent starts over.
                  const nextProvider = catalog?.providers.find(
                    (row) => row.driverKind === next.driverKind,
                  )
                  const nextModel = nextProvider?.models.find(
                    (row) => row.id === next.modelId || row.aliases?.includes(next.modelId ?? ''),
                  )
                  const kept =
                    next.driverKind === pick?.driverKind &&
                    pick.effort !== null &&
                    (nextModel?.efforts ?? nextProvider?.efforts ?? []).some(
                      (effort) => effort.id === pick.effort,
                    )
                      ? pick.effort
                      : null
                  setPick({
                    ...next,
                    effort: kept,
                    permissionMode: catalog?.defaults?.permissionMode ?? DEFAULT_PERMISSION_MODE,
                  })
                  rememberPick({ ...next, effort: kept })
                }}
              />
              {pick && (
                <TextPicker
                  label="Reasoning effort"
                  disabled={attempt !== null || pending}
                  value={pick.effort ?? ''}
                  onChange={(value) => {
                    setPick({ ...pick, effort: value || null })
                    rememberPick({ effort: value || null })
                  }}
                  options={[
                    // The spacer keeps this row's label in line with the ones that carry bars.
                    { value: '', label: 'Agent default', mark: <span className="size-[15px]" /> },
                    ...efforts.map((effort, index) => ({
                      value: effort.id,
                      label: sentenceCase(effort.label),
                      // One line per level: with six of them, descriptions made the menu a wall.
                      title: effort.description,
                      mark: (
                        <EffortGlyph
                          {...(effortLevels(efforts)[index] ?? { filled: 1, bars: 2 })}
                        />
                      ),
                    })),
                    // Until the host's catalog lands, the saved level still reads
                    // by name instead of the picker's "Choose" placeholder.
                    ...(catalog === null && pick.effort
                      ? [
                          {
                            value: pick.effort,
                            label: sentenceCase(pick.effort),
                            mark: <span className="size-[15px]" />,
                          },
                        ]
                      : []),
                  ]}
                />
              )}
              {pick && (
                <TextPicker
                  label="Permission mode"
                  disabled={attempt !== null || pending}
                  value={
                    modes.length > 0
                      ? ((
                          modes.find(
                            (mode) =>
                              mode.id === nativeModeId && mode.ariMode === pick.permissionMode,
                          ) ??
                          modes.find(
                            (mode) => mode.ariMode === pick.permissionMode && mode.current === true,
                          ) ??
                          modes.find((mode) => mode.ariMode === pick.permissionMode)
                        )?.id ?? '')
                      : pick.permissionMode
                  }
                  onChange={(value) => {
                    const native = modes.find((mode) => mode.id === value)
                    setNativeModeId(native?.id ?? null)
                    setPick({
                      ...pick,
                      permissionMode: native
                        ? native.ariMode
                        : (value as ProjectAgent['permissionMode']),
                    })
                  }}
                  mark={<ModeMark mode={pick.permissionMode} />}
                  options={
                    modes.length > 0
                      ? modes.map((mode) => ({
                          value: mode.id,
                          label: sentenceCase(mode.label),
                          hint: mode.description,
                          mark: <ModeMark mode={mode.ariMode} />,
                        }))
                      : DEFAULT_MODES
                  }
                />
              )}
            </>
          }
          belowControls={
            <>
              <MachinePicker
                hosts={hosts}
                selection={selection}
                locked={locked || pending}
                onSelect={(id) => {
                  if (locked || pendingRef.current) return
                  defaultAutoHandled.current = true
                  setCheckoutId(null)
                  setPick(null)
                  setWorkspaceToken(undefined)
                  setFailure(null)
                  if (id === 'auto') chooseAuto()
                  else {
                    autoGeneration.current++
                    setAutoSampling(false)
                    setSelection({
                      mode: 'manual',
                      hostId: id,
                      reason: `${hosts.find((host) => host.id === id)?.name ?? id} runs this draft.`,
                    })
                    onRememberHost(id)
                  }
                }}
              >
                {choices.length > 1 && (
                  <TextPicker
                    label="Project checkout"
                    value={projectId ?? ''}
                    disabled={locked}
                    placeholder="Choose a checkout"
                    onChange={(value) => setCheckoutId(value || null)}
                    options={choices.map((checkout) => ({
                      value: checkout.projectId,
                      label: checkout.checkoutLabel,
                    }))}
                  />
                )}
                {workspaces && (
                  <TextPicker
                    label="Project workspace"
                    value={workspaceToken ?? ''}
                    disabled={locked || pending || autoSampling}
                    onChange={(value) => {
                      const token = value || undefined
                      setWorkspaceToken(token)
                      const kind = workspaces.options.find((option) => option.token === token)?.kind
                      if (kind === 'branch' || kind === 'worktree') setWorkspaceLocked(true)
                    }}
                    options={[
                      {
                        value: '',
                        label: 'Automatic isolation',
                        hint: 'Ari picks a checkout or a fresh worktree',
                      },
                      ...workspaces.options.map((option) => ({
                        value: option.token,
                        label: option.label,
                        hint:
                          option.kind === 'worktree'
                            ? 'A new worktree; the checkout stays as it is'
                            : option.branch
                              ? `Works on ${option.branch}`
                              : undefined,
                      })),
                    ]}
                  />
                )}
              </MachinePicker>
              {!attempt && pickReason && (
                <p className="mt-1 text-xs text-fg-subtle" role="status">
                  {pickReason}
                </p>
              )}
            </>
          }
        />
      </ComposerDock>
    </div>
  )
}
