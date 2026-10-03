import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowDown,
  MoreHorizontal,
  GitBranch,
  Folder,
  MessageSquare,
  TerminalSquare,
} from 'lucide-react'
import type { Message } from '@ari/contracts/message'
import type {
  RemoteApproval,
  RemoteChangeFile,
  RemoteChanges,
  RemoteInput,
} from '@ari/contracts/remote'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import { useApp } from '../../lib/app-state'
import { BottomSheet } from '../../components/ui'
import { Conversation } from './Conversation'
import { Composer } from './Composer'
import { Files } from './Files'
import { SessionDetails } from './SessionDetails'
import { ReviewIntegration } from './ReviewIntegration'
import { ModelPicker, modelSelectionLabel } from '../../components/ModelPicker'
const Terminal = lazy(async () => {
  const module = await import('./Terminal')
  return { default: module.Terminal }
})

interface Snapshot {
  session: Session
  summary: SessionSummary
  seq: number
  messages: Message[]
  pendingApprovals: RemoteApproval[]
  pendingInputs: RemoteInput[]
}
type View = 'conversation' | 'changes' | 'files' | 'terminal'

/** A phone-sized workspace with resumable activity, explicit approvals, and durable drafts. */
export function SessionScreen({
  sessionId,
  onBack,
  onForked,
}: {
  sessionId: string
  onBack: () => void
  onForked: (sessionId: string) => void
}): ReactNode {
  const app = useApp()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [view, setView] = useState<View>('conversation')
  const [details, setDetails] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [pickingModel, setPickingModel] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [terminalOpened, setTerminalOpened] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const seq = useRef<number | null>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const load = useCallback(async (): Promise<void> => {
    const session = app.session
    if (session === null || !session.usable || inFlight.current) return
    inFlight.current = true
    try {
      const result = await session.query<Snapshot>('session.get', { sessionId })
      if (!alive.current) return
      seq.current = result.seq
      setSnapshot(result)
      setFailure(null)
    } catch (error) {
      if (alive.current) setFailure(messageOf(error))
    } finally {
      inFlight.current = false
    }
  }, [app.session, sessionId])
  useEffect(() => {
    void load()
  }, [load, app.connection])
  const loaded = snapshot !== null
  useEffect(() => {
    const session = app.session
    if (session === null || !session.usable || !loaded || !session.supports('events.subscribe'))
      return
    let closed = false
    let dispose: (() => void) | null = null
    let scheduled: ReturnType<typeof setTimeout> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    const open = (): void => {
      if (closed) return
      dispose = session.subscribe(sessionId, {
        ...(seq.current === null ? {} : { fromSeq: seq.current }),
        onFrame: () => {
          // A bounded throttle updates during continuous output; trailing debounce can starve forever.
          if (scheduled !== null) return
          scheduled = setTimeout(() => {
            scheduled = null
            void load()
          }, 700)
        },
        onClose: (info) => {
          if (
            closed ||
            info.code === 1000 ||
            (info.code === 1008 && app.managedComputerId === null)
          )
            return
          retry = setTimeout(() => {
            void app.reconnect().then(() => {
              if (!closed && session.usable) open()
            })
          }, 2000)
        },
      })
    }
    open()
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5000)
    return () => {
      closed = true
      dispose?.()
      if (scheduled !== null) clearTimeout(scheduled)
      if (retry !== null) clearTimeout(retry)
      clearInterval(poll)
    }
  }, [app.session, app.connection, app.reconnect, app.managedComputerId, sessionId, load, loaded])
  useEffect(() => {
    if (follow.current && view === 'conversation')
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight })
  }, [snapshot, view])
  const projectName =
    app.projects.find((project) => project.id === snapshot?.summary.projectId)?.name ?? 'Workspace'
  const can = (op: string): boolean =>
    app.session?.supports(op) === true && app.connection === 'connected'
  async function archive(): Promise<void> {
    try {
      await app.session?.send({ op: 'session.archive', sessionId })
      await app.refresh()
      onBack()
    } catch (error) {
      setFailure(messageOf(error))
    }
  }
  return (
    <div className="mobile-shell relative">
      <header className="shrink-0 border-b border-border px-3 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="icon-button"
            aria-label="Back"
            onClick={() => (view === 'conversation' ? onBack() : setView('conversation'))}
          >
            <ArrowLeft size={20} />
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 py-2 text-left"
            onClick={() => setDetails(true)}
            aria-label="Open session details"
          >
            <span className="block truncate text-[15px] font-semibold tracking-tight">
              {view === 'conversation'
                ? snapshot?.summary.title || 'Session'
                : view === 'changes'
                  ? 'Changes'
                  : view === 'files'
                    ? 'Files'
                    : 'Terminal'}
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
              <span
                className={`size-1.5 rounded-full ${app.connection !== 'connected' ? 'bg-warning' : snapshot?.session.status === 'running' ? 'bg-success' : 'bg-fg-subtle'}`}
              />
              {projectName} ·{' '}
              {app.connection !== 'connected'
                ? 'Offline'
                : snapshot?.session.status === 'running'
                  ? 'Working'
                  : snapshot?.session.status === 'waiting-approval'
                    ? 'Waiting for you'
                    : 'Ready'}
            </span>
          </button>
          <button
            type="button"
            className="icon-button text-fg-muted"
            aria-label="Workspace tools"
            onClick={() => setToolsOpen(true)}
          >
            <Folder size={20} />
          </button>
          <button
            type="button"
            className="icon-button text-fg-muted"
            aria-label="Session options"
            onClick={() => setDetails(true)}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      </header>
      {toolsOpen && (
        <BottomSheet title="Workspace" onClose={() => setToolsOpen(false)}>
          <ul className="divide-y divide-border pb-3">
            {(
              [
                { id: 'conversation', label: 'Chat', icon: MessageSquare, enabled: true },
                { id: 'changes', label: 'Changes', icon: GitBranch, enabled: can('changes.files') },
                { id: 'files', label: 'Files', icon: Folder, enabled: can('files.list') },
                {
                  id: 'terminal',
                  label: 'Terminal',
                  icon: TerminalSquare,
                  enabled: can('terminal.create'),
                },
              ] as const
            )
              .filter((entry) => entry.enabled)
              .map(({ id, label, icon: Icon }) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-pressed={view === id}
                    className="flex min-h-14 w-full items-center gap-3 text-left text-sm"
                    onClick={() => {
                      setView(id)
                      follow.current = id === 'conversation'
                      if (id === 'terminal') setTerminalOpened(true)
                      setToolsOpen(false)
                    }}
                  >
                    <Icon size={18} className="text-fg-muted" />
                    {label}
                  </button>
                </li>
              ))}
          </ul>
        </BottomSheet>
      )}
      {failure !== null && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-border bg-danger-subtle px-4 py-2 text-xs text-danger"
        >
          <span className="flex-1">{failure}</span>
          <button type="button" className="min-h-11 shrink-0" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {view === 'conversation' &&
        snapshot !== null &&
        snapshot.pendingApprovals.length + snapshot.pendingInputs.length > 0 && (
          <button
            type="button"
            className="flex min-h-11 shrink-0 items-center justify-between border-b border-border bg-warning-subtle px-5 text-xs"
            onClick={() => {
              follow.current = false
              scroll.current?.scrollTo({ top: 0 })
            }}
          >
            <span>
              {snapshot.pendingApprovals.length} approvals · {snapshot.pendingInputs.length}{' '}
              questions
            </span>
            <span className="font-medium">Review ↑</span>
          </button>
        )}
      <div
        ref={scroll}
        onScroll={() => {
          const element = scroll.current
          if (element !== null) {
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
            setShowJump(!follow.current)
          }
        }}
        className={`min-h-0 flex-1 px-5 py-5 ${view === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto'}`}
      >
        {snapshot === null && (
          <p role="status" className="text-sm text-fg-muted">
            Loading session…
          </p>
        )}
        {view === 'conversation' && snapshot !== null && (
          <>
            {snapshot.pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.approvalId}
                approval={approval}
                error={setFailure}
                onAnswer={async (optionId) => {
                  if (!can('approval.respond')) throw new Error('Reconnect before answering.')
                  await app.session?.send({
                    op: 'approval.respond',
                    sessionId,
                    approvalId: approval.approvalId,
                    optionId,
                  })
                  await load()
                }}
              />
            ))}
            {snapshot.pendingInputs.map((input) => (
              <QuestionCard
                key={input.inputId}
                input={input}
                error={setFailure}
                onAnswer={async (value) => {
                  if (!can('input.respond')) throw new Error('Reconnect before answering.')
                  await app.session?.send({
                    op: 'input.respond',
                    sessionId,
                    inputId: input.inputId,
                    value,
                  })
                  await load()
                }}
              />
            ))}
            <Conversation messages={snapshot.messages} sessionId={sessionId} />
          </>
        )}
        {view === 'changes' && (
          <>
            {snapshot?.session.parentSessionId != null && (
              <ReviewIntegration sessionId={sessionId} onChanged={load} />
            )}
            <Changes sessionId={sessionId} />
          </>
        )}
        {view === 'files' && <Files sessionId={sessionId} />}
        {terminalOpened && (
          <Suspense
            fallback={
              <p role="status" className="text-sm text-fg-muted">
                Loading terminal…
              </p>
            }
          >
            <Terminal sessionId={sessionId} active={view === 'terminal'} />
          </Suspense>
        )}
      </div>
      {view === 'conversation' && showJump && (
        <button
          type="button"
          aria-label="Jump to latest messages"
          className="absolute bottom-48 right-5 flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface-2 px-3 text-xs"
          onClick={() => {
            follow.current = true
            setShowJump(false)
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight })
          }}
        >
          <ArrowDown size={14} />
          Latest
        </button>
      )}
      {view === 'conversation' && (
        <Composer
          sessionId={sessionId}
          status={snapshot?.session.status ?? 'idle'}
          modelLabel={
            snapshot === null
              ? null
              : modelSelectionLabel(
                  app.catalog,
                  snapshot.session.driverKind,
                  snapshot.session.modelId ?? '',
                )
          }
          disabled={!can('session.prompt') || snapshot === null}
          modelDisabled={!can('session.update') || snapshot?.session.status === 'running'}
          onDetails={() => setPickingModel(true)}
          onSent={load}
          onError={setFailure}
        />
      )}
      {pickingModel && snapshot !== null && (
        <ModelPicker
          fixedProvider
          driverKind={snapshot.session.driverKind}
          modelId={snapshot.session.modelId ?? ''}
          onClose={() => setPickingModel(false)}
          onSelect={(_driver, modelId) => {
            if (!can('session.update') || snapshot.session.status === 'running') return
            void app.session
              ?.send({ op: 'session.update', sessionId, modelId: modelId || null })
              .then(async () => {
                await load()
                await app.refresh()
              })
              .catch((error: unknown) => setFailure(messageOf(error)))
          }}
        />
      )}
      {details && snapshot !== null && (
        <SessionDetails
          session={snapshot.session}
          onClose={() => setDetails(false)}
          onChanged={load}
          onForked={onForked}
          {...(can('session.archive')
            ? {
                onArchive: () => {
                  setDetails(false)
                  setArchiveConfirm(true)
                },
              }
            : {})}
        />
      )}
      {archiveConfirm && (
        <BottomSheet title="Archive session?" onClose={() => setArchiveConfirm(false)}>
          <p className="py-3 text-sm text-fg-muted">
            The session stays on your computer and can be restored there.
          </p>
          <button type="button" className="primary-button w-full" onClick={() => void archive()}>
            Archive
          </button>
        </BottomSheet>
      )}
    </div>
  )
}
function ApprovalCard({
  approval,
  onAnswer,
  error,
}: {
  approval: RemoteApproval
  onAnswer: (optionId: string) => Promise<void>
  error: (message: string) => void
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null)
  return (
    <section className="mb-3 rounded-2xl border border-warning bg-warning-subtle p-4">
      <h3 className="text-sm font-medium">Approval needed · {approval.toolName}</h3>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-2 font-mono text-2xs text-fg-muted">
        {approvalDetails(approval.summaryJson)}
      </pre>
      <div className="mt-3 space-y-2">
        {approval.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setBusy(option.optionId)
              void onAnswer(option.optionId)
                .catch((failure: unknown) => error(messageOf(failure)))
                .finally(() => setBusy(null))
            }}
            className="min-h-11 w-full rounded-xl border border-border bg-surface-1 px-3 py-2 text-left text-sm disabled:opacity-50"
          >
            {option.name}
          </button>
        ))}
      </div>
    </section>
  )
}

/** A question from the agent. Free text unless the provider offered choices. */
function QuestionCard({
  input,
  onAnswer,
  error,
}: {
  input: RemoteInput
  onAnswer: (value: string) => Promise<void>
  error: (message: string) => void
}): ReactNode {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const choices: string[] = parseChoices(input.choicesJson)
  async function answer(text: string): Promise<void> {
    if (busy || text.trim().length === 0) return
    setBusy(true)
    try {
      await onAnswer(text)
      setValue('')
    } catch (failure) {
      error(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-3 rounded-2xl border border-info bg-info-subtle p-4">
      <h3 className="text-sm font-medium">The agent is asking</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm">{input.prompt}</p>
      {choices.length > 0 ? (
        <div className="mt-3 space-y-2">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy}
              onClick={() => void answer(choice)}
              className="min-h-11 w-full rounded-md border border-border bg-surface-1 px-3 text-left text-sm"
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void answer(value)
          }}
        >
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Your answer"
            disabled={busy}
            className="h-11 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3"
          />
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="h-11 rounded-md bg-accent px-3 text-fg-on-accent disabled:opacity-40"
          >
            {busy ? 'Sending…' : 'Answer'}
          </button>
        </form>
      )}
    </section>
  )
}

function Changes({ sessionId }: { sessionId: string }): ReactNode {
  const app = useApp()
  const supported = app.session?.supports('changes.files') ?? false
  const [listing, setListing] = useState<RemoteChanges | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [openFile, setOpenFile] = useState<RemoteChangeFile | null>(null)
  const [openFailure, setOpenFailure] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)

  useEffect(() => {
    if (!supported || app.session === null) return
    const session = app.session
    let cancelled = false
    setListing(null)
    setFailure(null)
    setOpenPath(null)
    void session
      .query<RemoteChanges>('changes.files', { sessionId })
      .then((next) => {
        if (!cancelled) setListing(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(messageOf(error))
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, app.session, supported])

  if (!supported) {
    return (
      <p className="text-sm text-fg-muted">
        This desktop does not offer a per-file change list for a session. Read the conversation for
        what the agent did, or review the changes on the computer.
      </p>
    )
  }

  async function open(path: string): Promise<void> {
    if (app.session === null) return
    setOpenPath(path)
    setOpenFile(null)
    setOpenFailure(null)
    setLoadingFile(true)
    try {
      const next = await app.session.query<{
        file: RemoteChangeFile | null
        error: string | null
      }>('changes.diff', { sessionId, path })
      if (next.error !== null) setOpenFailure(next.error)
      else if (next.file === null) setOpenFailure('that file is no longer in the change list')
      else setOpenFile(next.file)
    } catch (error) {
      setOpenFailure(messageOf(error))
    } finally {
      setLoadingFile(false)
    }
  }

  function close(): void {
    setOpenPath(null)
    setOpenFile(null)
    setOpenFailure(null)
  }

  if (openPath !== null) {
    return (
      <div>
        <button
          type="button"
          onClick={close}
          aria-label="Back to changed files"
          className="flex min-h-11 items-center gap-2 text-sm text-fg-muted"
        >
          ← Files
        </button>
        <h3 className="mt-1 break-words font-mono text-sm font-medium">{openPath}</h3>
        {loadingFile && <p className="mt-2 text-sm text-fg-muted">Reading that file…</p>}
        {openFailure !== null && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {openFailure}
          </p>
        )}
        {openFile !== null && <FileDiff file={openFile} />}
      </div>
    )
  }

  if (failure !== null) {
    return (
      <div>
        <p role="alert" className="text-sm text-danger">
          {failure}
        </p>
        <button
          type="button"
          onClick={() => {
            setFailure(null)
            setListing(null)
            void app.session
              ?.query<RemoteChanges>('changes.files', { sessionId })
              .then(setListing)
              .catch((error: unknown) => setFailure(messageOf(error)))
          }}
          className="mt-2 min-h-11 rounded-md border border-border bg-surface-1 px-3 text-sm"
        >
          Try again
        </button>
      </div>
    )
  }

  if (listing === null) {
    return <p className="text-sm text-fg-muted">Reading changes…</p>
  }

  if (listing.error !== null) {
    return <p className="text-sm text-fg-muted">{listing.error}</p>
  }

  if (listing.files.length === 0) {
    return <p className="text-sm text-fg-muted">Nothing has changed in this session yet.</p>
  }

  return (
    <div>
      <p className="mb-2 text-2xs text-fg-subtle">
        {listing.base === 'session-base'
          ? 'Against where this session started.'
          : 'Uncommitted changes in the project.'}
      </p>
      <ol className="space-y-2">
        {listing.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => void open(file.path).catch(() => undefined)}
              aria-label={`Show changes in ${file.path}`}
              className="min-h-11 w-full rounded-xl border border-border bg-surface-1 px-3 py-2 text-left"
            >
              <span className="block break-words font-mono text-sm">{file.path}</span>
              <span className="mt-0.5 block text-2xs text-fg-subtle">{fileStatus(file)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** A file's change kind in words, never color alone. */
function fileStatus(file: {
  oldPath?: string
  isNew?: boolean
  isDeleted?: boolean
  isBinary?: boolean
}): string {
  if (file.isBinary === true) return 'Binary file'
  if (file.isNew === true) return 'Added'
  if (file.isDeleted === true) return 'Deleted'
  if (file.oldPath !== undefined) return `Renamed from ${file.oldPath}`
  return 'Modified'
}

/** One file's hunks, with `+`/`-` markers in text rather than color alone. */
function FileDiff({ file }: { file: RemoteChangeFile }): ReactNode {
  if (file.isBinary === true) {
    return <p className="mt-2 text-sm text-fg-muted">A binary file cannot be previewed here.</p>
  }
  if (file.hunks.length === 0) {
    return (
      <p className="mt-2 text-sm text-fg-muted">
        {file.isNew === true
          ? 'An added file with no preview in this build — read it on the computer.'
          : 'No preview for this file in this build.'}
      </p>
    )
  }
  return (
    <div className="mt-2 space-y-3">
      {file.hunks.map((hunk, index) => (
        <section key={`${hunk.header}-${index}`} aria-label={`Change ${index + 1}`}>
          <p className="font-mono text-2xs text-fg-subtle">{hunk.header}</p>
          <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface-1 p-2 font-mono text-2xs leading-relaxed">
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={lineIndex}
                className={
                  line.type === 'add'
                    ? 'bg-accent-subtle'
                    : line.type === 'del'
                      ? 'bg-danger-subtle'
                      : undefined
                }
              >
                {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                {line.content}
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  )
}

function parseChoices(choicesJson: string | null): string[] {
  if (choicesJson === null) return []
  try {
    const parsed: unknown = JSON.parse(choicesJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'the desktop refused that'
}

function approvalDetails(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2)
  } catch {
    return value
  }
}
