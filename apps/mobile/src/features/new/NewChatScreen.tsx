import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, ChevronLeft, Folder, LoaderCircle } from 'lucide-react'
import type { PermissionMode } from '@ari/contracts/common'
import { EmptyState } from '../../components/EmptyState'
import { ModelPicker, modelChipLabel } from '../../components/ModelPicker'
import { OptionSheet } from '../../components/OptionSheet'
import { SessionControls } from '../../components/SessionControls'
import { useApp } from '../../lib/app-state'
import { sessionIdOf } from '../../lib/command-result'
import { writeDraft, writePending, type PendingSubmission } from '../../lib/draft'
import { RemoteError } from '../../lib/gateway-client'
import { readCreation, writeCreation, type NewSessionRequest } from '../../lib/new-session'

/** Failures after which the desktop may still have acted, so the same receipt is kept. */
const uncertain = (error: unknown): boolean =>
  !(error instanceof RemoteError) ||
  ['unreachable', 'internal_error', 'conflict'].includes(error.code)

/**
 * A conversation that does not exist yet. Sending creates the session once,
 * keeping its receipt through a lost answer, then sends the first message.
 */
export function NewChatScreen({
  projectId,
  onBack,
  onOpen,
}: {
  projectId?: string
  onBack: () => void
  onOpen: (sessionId: string) => void
}): ReactNode {
  const app = useApp()
  const deviceId = app.session?.deviceId ?? null
  const [restored] = useState(() => readCreation(app.origin, deviceId))
  const [project, setProject] = useState(
    restored?.projectId ?? projectId ?? app.projects[0]?.id ?? '',
  )
  const [provider, setProvider] = useState(restored?.driverKind ?? '')
  const [model, setModel] = useState(restored?.modelId ?? '')
  const [effort, setEffort] = useState<string | null>(restored?.effort ?? null)
  const [mode, setMode] = useState<PermissionMode | null>(restored?.permissionMode ?? null)
  const [text, setText] = useState(restored?.draft ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(
    restored === null
      ? null
      : 'The last new chat was not confirmed by your computer. Retry checks the same request, so it cannot create a second session.',
  )
  const [pending, setPending] = useState<NewSessionRequest | null>(restored)
  const [picking, setPicking] = useState<'model' | 'project' | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (area.current !== null) {
      area.current.style.height = 'auto'
      area.current.style.height = `${Math.min(200, area.current.scrollHeight)}px`
    }
  }, [text])

  async function start(): Promise<void> {
    const session = app.session
    if (busy || session === null || !project || (pending === null && !text.trim())) return
    const command = pending ?? {
      key: crypto.randomUUID(),
      projectId: project,
      driverKind: provider,
      modelId: model,
      effort,
      permissionMode: mode,
      draft: text.trim(),
    }
    if (!writeCreation(app.origin, deviceId, command)) {
      setFailure(
        'This browser cannot keep the receipt for a new chat. Free some browser storage, then send again.',
      )
      return
    }
    setPending(command)
    setBusy(true)
    setFailure(null)
    let id: string | null
    try {
      id = sessionIdOf(
        await session.send(
          {
            op: 'session.create',
            projectId: command.projectId,
            ...(command.driverKind === '' ? {} : { driverKind: command.driverKind }),
            ...(command.modelId === '' ? {} : { modelId: command.modelId }),
            ...(command.permissionMode === null ? {} : { permissionMode: command.permissionMode }),
            ...(command.effort === null ? {} : { effort: command.effort }),
          },
          command.key,
        ),
      )
      if (id === null) throw new Error('Your computer did not return a session. Retry to check.')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not start this chat.')
      if (!uncertain(error)) {
        setPending(null)
        writeCreation(app.origin, deviceId, null)
      }
      setBusy(false)
      return
    }
    writeCreation(app.origin, deviceId, null)
    await sendFirst(id, command.draft)
    await app
      .refresh()
      .catch((error: unknown) => console.warn('Started a chat; refreshing the list failed', error))
    onOpen(id)
  }

  /** Whatever happens to the first message, the session exists, so it opens holding the message. */
  async function sendFirst(sessionId: string, message: string): Promise<void> {
    if (message === '' || app.session === null) return
    const receipt: PendingSubmission = {
      key: crypto.randomUUID(),
      text: message,
      mode: 'send',
      attachmentIds: [],
    }
    if (!writePending(app.origin, deviceId, sessionId, receipt)) {
      writeDraft(app.origin, sessionId, message, deviceId)
      return
    }
    try {
      await app.session.send({ op: 'session.prompt', sessionId, text: message }, receipt.key)
      writePending(app.origin, deviceId, sessionId, null)
    } catch (error) {
      if (uncertain(error)) return
      writePending(app.origin, deviceId, sessionId, null)
      writeDraft(app.origin, sessionId, message, deviceId)
    }
  }

  const locked = busy || pending !== null
  const projectName = app.projects.find((entry) => entry.id === project)?.name ?? 'Project'
  const header = (
    <header className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <button type="button" className="icon-button" aria-label="Back" onClick={onBack}>
        <ChevronLeft size={24} />
      </button>
      <h1 className="min-w-0 flex-1 text-[16px] font-semibold tracking-tight">New chat</h1>
      {app.projects.length > 0 && (
        <button
          type="button"
          className="control-chip mr-2 max-w-44 shrink-0"
          aria-label={`Project: ${projectName}`}
          disabled={locked || app.projects.length < 2}
          onClick={() => setPicking('project')}
        >
          <Folder size={14} className="shrink-0" />
          <span className="truncate">{projectName}</span>
          {app.projects.length > 1 && <ChevronDown size={13} className="shrink-0" />}
        </button>
      )}
    </header>
  )
  if (app.projects.length === 0)
    return (
      <div className="mobile-shell">
        {header}
        <EmptyState
          title="Share a project first"
          detail="Choose the projects this phone can use in Mobile access settings on your computer."
        />
      </div>
    )
  return (
    <div className="mobile-shell">
      {header}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
        <p className="text-[26px] font-semibold leading-tight tracking-[-0.04em]">
          What should we work on?
        </p>
        <p className="mt-2 text-sm text-fg-muted">The agent works on your computer, in {projectName}.</p>
      </div>
      {failure !== null && (
        <p role="alert" className="error-banner mx-4">
          {failure}
        </p>
      )}
      <form
        className="mobile-composer shrink-0 px-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <div className="rounded-3xl border border-border bg-surface-1 p-2">
          <textarea
            ref={area}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            autoFocus
            disabled={locked}
            placeholder="Describe a task"
            aria-label="Describe a task"
            className="max-h-[200px] min-h-16 w-full resize-none bg-transparent px-2 py-2.5 text-base leading-relaxed outline-none placeholder:text-fg-subtle"
          />
          <div className="flex items-center gap-2">
            <div className="no-scrollbar flex min-h-11 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
              <SessionControls
                driverKind={provider || app.catalog?.defaults?.driverKind || ''}
                modelId={model}
                modelLabel={modelChipLabel(
                  app.catalog,
                  provider || app.catalog?.defaults?.driverKind || '',
                  model,
                )}
                effort={effort}
                permissionMode={mode ?? app.catalog?.defaults?.permissionMode ?? 'ask'}
                disabled={locked}
                onPickModel={() => setPicking('model')}
                onEffort={setEffort}
                onMode={setMode}
              />
            </div>
            <button
              type="submit"
              className="icon-button rounded-full bg-accent text-fg-on-accent"
              aria-label={pending !== null && !busy ? 'Retry' : 'Send'}
              disabled={
                busy || app.connection !== 'connected' || (pending === null && !text.trim())
              }
            >
              {busy ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={20} />}
            </button>
          </div>
        </div>
      </form>
      {picking === 'project' && (
        <OptionSheet
          title="Project"
          options={app.projects.map((entry) => ({ value: entry.id, label: entry.name }))}
          selected={project}
          onSelect={setProject}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === 'model' && (
        <ModelPicker
          driverKind={provider}
          modelId={model}
          onClose={() => setPicking(null)}
          onSelect={(nextProvider, nextModel) => {
            // Levels belong to a provider and model, so a saved one may not carry over.
            if (nextProvider !== provider || nextModel !== model) setEffort(null)
            setProvider(nextProvider)
            setModel(nextModel)
          }}
        />
      )}
    </div>
  )
}
