import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ArrowDown,
  ChevronLeft,
  CornerLeftUp,
  Gauge,
  MoreHorizontal,
  SlidersHorizontal,
  TerminalSquare,
} from 'lucide-react'
import type { RemoteChangeFile, RemoteChanges } from '@ari/contracts/remote'
import type { PermissionMode } from '@ari/contracts/common'
import type { ChildTask } from '@ari/contracts/agent-control'
import { useApp } from '../../lib/app-state'
import { delivered } from '../../lib/transcript'
import { useTranscript } from '../../lib/use-transcript'
import type { OutboxEntry } from './Composer'
import { ConnectionStrip } from '../../components/ConnectionStrip'
import { agentState, agentsStatus } from '../../lib/delegation'
import { Agents } from './Agents'
import { BottomSheet } from '../../components/ui'
import { Conversation } from './Conversation'
import { AttentionDock } from './AttentionDock'
import { Composer } from './Composer'
import { Files } from './Files'
import { SessionDetails } from './SessionDetails'
import { UsageSheet } from '../usage/UsageSheet'
import { ReviewIntegration } from './ReviewIntegration'
import { ModelPicker, modelChipLabel } from '../../components/ModelPicker'
import { SessionControls } from '../../components/SessionControls'
import { EmptyState } from '../../components/EmptyState'
import { computerName } from '../../lib/computers'
const Terminal = lazy(async () => {
  const module = await import('./Terminal')
  return { default: module.Terminal }
})

const NO_TASKS: ChildTask[] = []
type View = 'conversation' | 'changes' | 'files' | 'terminal'

/** A phone-sized workspace with resumable activity, explicit approvals, and durable drafts. */
export function SessionScreen(props: {
  sessionId: string
  onBack: () => void
  onForked: (sessionId: string) => void
  onOpenSession?: (sessionId: string) => void
}): ReactNode {
  const app = useApp()
  return (
    <SessionWorkspace
      key={`${app.origin}:${app.session?.deviceId ?? ''}:${props.sessionId}`}
      {...props}
    />
  )
}

function SessionWorkspace({
  sessionId,
  onBack,
  onForked,
  onOpenSession = onForked,
}: {
  sessionId: string
  onBack: () => void
  onForked: (sessionId: string) => void
  /** Moves to another session: a delegated agent, or the session that delegated to this one. */
  onOpenSession?: (sessionId: string) => void
}): ReactNode {
  const app = useApp()
  const {
    transcript: snapshot,
    failure: readFailure,
    reload: load,
    loadEarlier,
    loadingEarlier,
  } = useTranscript(sessionId)
  const [view, setView] = useState<View>('conversation')
  const [details, setDetails] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [usage, setUsage] = useState(false)
  const [pickingModel, setPickingModel] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false)
  const [terminalOpened, setTerminalOpened] = useState(false)
  const [actionFailure, setFailure] = useState<string | null>(null)
  const failure = actionFailure ?? readFailure
  const [showJump, setShowJump] = useState(false)
  const [outbox, setOutbox] = useState<OutboxEntry | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  /** Distance from the bottom before an older page was added above. */
  const anchor = useRef<number | null>(null)
  const firstMessageId = snapshot?.messages[0]?.id
  // An older page is added above what the user is reading; keep their place.
  useLayoutEffect(() => {
    const element = scroll.current
    if (element !== null && anchor.current !== null) {
      element.scrollTop = element.scrollHeight - anchor.current
      anchor.current = null
    }
  }, [firstMessageId])
  const stickToBottom = useCallback((): void => {
    const element = scroll.current
    if (element !== null && follow.current && view === 'conversation')
      element.scrollTop = element.scrollHeight
  }, [view])
  useLayoutEffect(stickToBottom, [snapshot, outbox, stickToBottom])
  const hasTranscript = snapshot !== null
  useEffect(() => {
    // Content growing (a streamed reply, an image loading, the keyboard
    // shrinking the viewport) keeps the newest line in view while following.
    const element = scroll.current
    const inner = content.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(stickToBottom)
    observer.observe(element)
    if (inner !== null) observer.observe(inner)
    return () => observer.disconnect()
  }, [stickToBottom, hasTranscript])
  // An accepted message leaves the outbox once the conversation shows it.
  const outboxFrom = useRef(0)
  const messageCount = useRef(0)
  useLayoutEffect(() => {
    messageCount.current = snapshot?.messages.length ?? 0
  })
  const changeOutbox = useCallback((entry: OutboxEntry | null): void => {
    if (entry?.state === 'sending') outboxFrom.current = messageCount.current
    setOutbox(entry)
  }, [])
  useEffect(() => {
    if (
      outbox?.state === 'accepted' &&
      snapshot !== null &&
      delivered(snapshot.messages, outbox.text, outboxFrom.current)
    )
      setOutbox(null)
  }, [outbox, snapshot])
  useEffect(() => {
    if (outbox?.state !== 'accepted') return
    // A steer, or a desktop that records it differently: do not keep it forever.
    const expire = setTimeout(() => setOutbox(null), 10_000)
    return () => clearTimeout(expire)
  }, [outbox])
  const waiting =
    snapshot !== null && snapshot.pendingApprovals.length + snapshot.pendingInputs.length > 0
  /** The journal says running, yet nothing executes on the desktop. */
  const stalled = snapshot?.session.status === 'running' && snapshot.summary.live === false
  // The turn began with the last message the user sent.
  const workingSince = snapshot?.messages.findLast((message) => message.role === 'user')?.createdAt
  const open = (next: View): void => {
    setView(next)
    follow.current = next === 'conversation'
    if (next === 'terminal') setTerminalOpened(true)
    setToolsOpen(false)
  }
  const projectName =
    app.projects.find((project) => project.id === snapshot?.summary.projectId)?.name ?? 'Workspace'
  const tasks = snapshot?.tasks ?? NO_TASKS
  const parent = snapshot?.parent ?? null
  /** A session that ended its turn to wait is not "ready": its agents are still at it. */
  const delegated = agentsStatus(tasks)
  const sessions = app.sessions
  // Stable between renders, so streamed updates re-render only the message that changed.
  const titleOf = useCallback(
    (id: string): string | undefined =>
      tasks.find((task) => task.sessionId === id)?.title ??
      (parent?.id === id ? parent.title : sessions.find((entry) => entry.id === id)?.title),
    [tasks, parent, sessions],
  )
  /** Each running agent is stopped in turn; the desktop carries a stop down to whatever it delegated. */
  async function stopAgents(): Promise<void> {
    const session = app.session
    if (session === null) return
    const running = tasks.filter((task) => {
      const state = agentState(task)
      return state === 'working' || state === 'needs-you'
    })
    const results = await Promise.allSettled(
      running.map((task) => session.send({ op: 'session.interrupt', sessionId: task.sessionId })),
    )
    if (results.some((result) => result.status === 'rejected'))
      setFailure('Some agents could not be stopped.')
    await load()
  }
  const can = (op: string): boolean =>
    app.session?.supports(op) === true && app.connection === 'connected'
  /** Model, effort and mode changes are confirmed by re-reading the session, never assumed. */
  function update(
    change: { modelId: string | null } | { effort: string } | { permissionMode: PermissionMode },
  ): void {
    void app.session
      ?.send({ op: 'session.update', sessionId, ...change })
      .then(async () => {
        await load()
        await app.refresh()
      })
      .catch((error: unknown) => setFailure(messageOf(error)))
  }
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
      <header className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button
          type="button"
          className="icon-button"
          aria-label={view === 'conversation' ? 'Back' : 'Back to chat'}
          onClick={() => (view === 'conversation' ? onBack() : setView('conversation'))}
        >
          <ChevronLeft size={24} />
        </button>
        <div className="min-w-0 flex-1 py-1.5">
          <h1 className="truncate text-[16px] font-semibold tracking-tight">
            {view === 'conversation'
              ? snapshot?.summary.title || 'Session'
              : view === 'changes'
                ? 'Changes'
                : view === 'files'
                  ? 'Files'
                  : 'Terminal'}
          </h1>
          <p className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span
              className={`size-1.5 rounded-full ${app.connection !== 'connected' ? 'bg-fg-subtle' : stalled ? 'bg-warning' : snapshot?.session.status === 'running' ? 'status-pulse bg-success' : waiting || delegated?.endsWith('you') === true ? 'bg-warning' : snapshot?.session.status === 'error' ? 'bg-danger' : 'bg-fg-subtle'}`}
            />
            <span className="truncate">
              {`${app.activeComputer?.name ?? (app.origin === null ? 'Computer' : computerName(app.origin))} · ${projectName}, ${
                app.connection !== 'connected'
                  ? 'last known state'
                  : stalled
                    ? 'not responding'
                    : snapshot?.session.status === 'running'
                      ? 'working'
                      : waiting
                        ? 'waiting for you'
                        : snapshot?.session.status === 'error'
                          ? 'stopped with an error'
                          : (delegated ?? 'ready')
              }`}
            </span>
          </p>
        </div>
        <button
          type="button"
          className="icon-button text-fg-muted"
          aria-label="More"
          onClick={() => setToolsOpen(true)}
        >
          <MoreHorizontal size={20} />
        </button>
      </header>
      <nav
        aria-label="Session views"
        className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pb-2"
      >
        {(
          [
            { id: 'conversation', label: 'Chat', available: true },
            {
              id: 'changes',
              label: 'Changes',
              available: app.session?.supports('changes.files') === true,
            },
            {
              id: 'files',
              label: 'Files',
              available: app.session?.supports('files.list') === true,
            },
            {
              id: 'terminal',
              label: 'Terminal',
              available: app.session?.supports('terminal.create') === true,
            },
          ] as const
        )
          .filter((entry) => entry.available)
          .map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={view === entry.id}
              className="workspace-tab"
              disabled={entry.id !== 'conversation' && app.connection !== 'connected'}
              onClick={() => open(entry.id)}
            >
              {entry.label}
            </button>
          ))}
      </nav>
      <ConnectionStrip detail="Your draft stays on this phone." />
      {stalled && app.connection === 'connected' && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5 text-xs text-fg-muted"
        >
          <p className="min-w-0 flex-1">
            The agent stopped responding on your computer. Stop it to use this session again.
          </p>
          {can('session.interrupt') && (
            <button
              type="button"
              className="min-h-9 shrink-0 font-medium text-fg"
              onClick={() =>
                void app.session
                  ?.send({ op: 'session.interrupt', sessionId })
                  .then(load)
                  .then(app.refresh)
                  .catch((error: unknown) => setFailure(messageOf(error)))
              }
            >
              Stop
            </button>
          )}
        </div>
      )}
      {toolsOpen && (
        <BottomSheet
          title={snapshot?.summary.title || 'Session'}
          onClose={() => setToolsOpen(false)}
        >
          <ul className="pb-2">
            {(
              [
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
                    className="flex min-h-14 w-full items-center gap-3 text-left text-[15px]"
                    onClick={() => open(id)}
                  >
                    <Icon size={18} className="text-fg-muted" />
                    {label}
                  </button>
                </li>
              ))}
            {can('usage.allowance') && (
              <li>
                <button
                  type="button"
                  className="flex min-h-14 w-full items-center gap-3 text-left text-[15px]"
                  onClick={() => {
                    setToolsOpen(false)
                    setUsage(true)
                  }}
                >
                  <Gauge size={18} className="text-fg-muted" />
                  Usage
                </button>
              </li>
            )}
            <li>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 text-left text-[15px]"
                disabled={snapshot === null}
                onClick={() => {
                  setToolsOpen(false)
                  setDetails(true)
                }}
              >
                <SlidersHorizontal size={18} className="text-fg-muted" />
                Details
              </button>
            </li>
          </ul>
        </BottomSheet>
      )}
      {view === 'conversation' && parent !== null && (
        <button
          type="button"
          aria-label={`Open parent session: ${parent.title}`}
          className="mx-4 mb-1 flex min-h-9 shrink-0 items-center gap-1.5 self-start rounded-full bg-surface-1 px-3 text-xs text-fg-muted"
          onClick={() => onOpenSession(parent.id)}
        >
          <CornerLeftUp size={13} aria-hidden className="shrink-0 text-accent" />
          <span className="max-w-[70vw] truncate">{parent.title || 'Parent session'}</span>
        </button>
      )}
      {failure !== null && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-border bg-danger-subtle px-4 py-2 text-xs text-danger"
        >
          <span className="flex-1">{failure}</span>
          <button
            type="button"
            className="min-h-11 shrink-0"
            onClick={() => {
              setFailure(null)
              void load()
            }}
          >
            Refresh session
          </button>
        </div>
      )}
      <div
        ref={scroll}
        onScroll={() => {
          const element = scroll.current
          if (element !== null) {
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120
            if (showJump === follow.current) setShowJump(!follow.current)
          }
        }}
        className={`min-h-0 flex-1 overscroll-contain px-5 py-5 [overflow-anchor:none] ${view === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto'}`}
      >
        {snapshot === null && app.connection !== 'connected' ? (
          <EmptyState
            title="Reconnect to this session"
            detail="The conversation stays on your computer. Your saved draft is here when the connection returns."
          />
        ) : (
          snapshot === null && (
            <p role="status" className="text-sm text-fg-muted">
              Loading session…
            </p>
          )
        )}
        {view === 'conversation' && snapshot !== null && (
          <div ref={content}>
            {snapshot.earlier > 0 && (
              <button
                type="button"
                className="mx-auto mb-4 flex min-h-9 items-center px-3 text-xs text-fg-subtle"
                disabled={loadingEarlier}
                onClick={() => {
                  const element = scroll.current
                  if (element !== null) anchor.current = element.scrollHeight - element.scrollTop
                  void loadEarlier()
                }}
              >
                {loadingEarlier
                  ? 'Loading earlier messages…'
                  : `Show ${snapshot.earlier} earlier messages`}
              </button>
            )}
            <Conversation
              messages={snapshot.messages}
              sessionId={sessionId}
              running={snapshot.session.status === 'running' && !stalled}
              titleOf={titleOf}
              onOpenSession={onOpenSession}
              outbox={outbox}
            />
          </div>
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
        <div className="relative h-0 shrink-0">
          <button
            type="button"
            aria-label="Jump to latest messages"
            className="absolute -top-14 left-1/2 flex size-10 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-surface-2 shadow-[var(--ari-shadow-2)]"
            onClick={() => {
              follow.current = true
              setShowJump(false)
              scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' })
            }}
          >
            <ArrowDown size={17} />
          </button>
        </div>
      )}
      {view === 'conversation' && (
        <Agents
          tasks={tasks}
          onOpen={onOpenSession}
          {...(can('session.interrupt') ? { onStopAll: stopAgents } : {})}
        />
      )}
      {view === 'conversation' && waiting && snapshot !== null && (
        <AttentionDock
          disabled={app.connection !== 'connected'}
          approvals={snapshot.pendingApprovals}
          inputs={snapshot.pendingInputs}
          onApprove={async (approvalId, optionId) => {
            if (!can('approval.respond')) throw new Error('Reconnect before answering.')
            await app.session?.send({ op: 'approval.respond', sessionId, approvalId, optionId })
            await load()
          }}
          onAnswer={async (inputId, value) => {
            if (!can('input.respond')) throw new Error('Reconnect before answering.')
            await app.session?.send({ op: 'input.respond', sessionId, inputId, value })
            await load()
          }}
        />
      )}
      {view === 'conversation' && !waiting && (
        <Composer
          sessionId={sessionId}
          // A dead turn is not work in progress; the banner above offers to stop it.
          status={stalled ? 'idle' : (snapshot?.session.status ?? 'idle')}
          disabled={!can('session.prompt') || snapshot === null}
          {...(workingSince === undefined ? {} : { workingSince })}
          controls={
            snapshot !== null && (
              <SessionControls
                driverKind={snapshot.session.driverKind}
                modelId={snapshot.session.modelId ?? ''}
                modelLabel={modelChipLabel(
                  app.catalog,
                  snapshot.session.driverKind,
                  snapshot.session.modelId ?? '',
                )}
                effort={snapshot.session.effort ?? null}
                permissionMode={snapshot.session.permissionMode}
                running={snapshot.session.status === 'running'}
                disabled={!can('session.update')}
                modelDisabled={snapshot.session.status === 'running'}
                onPickModel={() => setPickingModel(true)}
                onEffort={(effort) => update({ effort })}
                onMode={(permissionMode) => update({ permissionMode })}
              />
            )
          }
          onSent={load}
          onError={setFailure}
          onOutbox={changeOutbox}
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
            update({ modelId: modelId || null })
          }}
        />
      )}
      {usage && (
        <UsageSheet
          {...(snapshot === null ? {} : { current: snapshot.session.driverKind })}
          onClose={() => setUsage(false)}
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

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'the desktop refused that'
}
