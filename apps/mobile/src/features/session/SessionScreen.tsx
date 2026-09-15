import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Message } from '@ari/contracts/message'
import type { RemoteApproval, RemoteInput } from '@ari/contracts/remote'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import { useApp } from '../../lib/app-state'
import { relativeTime, summarizeToolDetail } from '../../lib/format'

/**
 * One session: the conversation, the composer, and what is waiting to be
 * answered (ADR §13–14).
 *
 * The three views are tabs rather than routes, and the snapshot is the source
 * of truth: events arriving over the socket say activity happened, and the
 * snapshot is re-read once the burst is over. That trades a little bandwidth
 * for not having a second, subtly different projection of the journal on the
 * phone — the desktop's projection is the one the user's other screen shows.
 */

type Tab = 'conversation' | 'changes' | 'details'

interface Snapshot {
  session: Session
  summary: SessionSummary
  seq: number
  messages: Message[]
  pendingApprovals: RemoteApproval[]
  pendingInputs: RemoteInput[]
}

export function SessionScreen({
  sessionId,
  onBack,
}: {
  sessionId: string
  onBack: () => void
}): ReactNode {
  const app = useApp()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tab, setTab] = useState<Tab>('conversation')
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState(false)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function load(): Promise<void> {
    if (app.session === null) return
    try {
      const next = await app.session.query<Snapshot>('session.get', { sessionId })
      setSnapshot(next)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'could not read that session')
    }
  }

  useEffect(() => {
    void load()
  }, [sessionId, app.session])

  // The live stream, opened once per session and reopened if it drops.
  //
  // Events are coalesced into one re-read of the snapshot rather than applied
  // one by one: the desktop's projection is the same one its own window shows,
  // and a second, subtly different fold of the journal on the phone is how the
  // two screens start disagreeing about what a session contains.
  const resumeFrom = useRef<number | null>(null)
  useEffect(() => {
    if (app.session === null) return
    let closed = false
    let close: (() => void) | null = null
    let retry: ReturnType<typeof setTimeout> | null = null

    const open = (): void => {
      if (closed) return
      const session = app.session
      if (session === null) return
      close = session.subscribe(sessionId, {
        ...(resumeFrom.current === null ? {} : { fromSeq: resumeFrom.current }),
        onFrame: () => {
          setActivity(true)
          if (settle.current !== null) clearTimeout(settle.current)
          settle.current = setTimeout(() => {
            setActivity(false)
            void load()
          }, 1200)
        },
        onClose: (info) => {
          setActivity(false)
          // 1000 is the client closing on purpose; anything else is the link
          // going away, which a phone should simply try again through.
          if (info.code === 1000 || closed) return
          retry = setTimeout(open, 2000)
        },
      })
    }
    open()

    return () => {
      closed = true
      if (settle.current !== null) clearTimeout(settle.current)
      if (retry !== null) clearTimeout(retry)
      close?.()
    }
  }, [sessionId, app.session])

  // Resume from where the last snapshot was taken, so a dropped socket does
  // not leave a hole in the conversation.
  useEffect(() => {
    if (snapshot !== null) resumeFrom.current = snapshot.seq
  }, [snapshot])

  const can = (operation: string): boolean => app.session?.supports(operation) ?? false

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <header className="shrink-0 border-b border-border bg-surface-0 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-md text-fg-muted"
            aria-label="Back to sessions"
          >
            ←
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {snapshot?.summary.title ?? 'Session'}
            </p>
            <p className="truncate text-2xs text-fg-subtle">
              {snapshot === null ? 'Loading…' : `${snapshot.session.driverKind} · ${snapshot.session.status}`}
              {activity && ' · working…'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="h-11 px-2 text-xs text-fg-muted"
            aria-label="Refresh this session"
          >
            Refresh
          </button>
        </div>

        <div role="tablist" aria-label="Session views" className="mt-2 flex gap-1">
          {(['conversation', 'changes', 'details'] as const).map((entry) => (
            <button
              key={entry}
              role="tab"
              aria-selected={tab === entry}
              type="button"
              onClick={() => setTab(entry)}
              className={`h-9 flex-1 rounded-md text-xs capitalize ${
                tab === entry ? 'bg-surface-2 font-medium text-fg' : 'text-fg-muted'
              }`}
            >
              {entry}
            </button>
          ))}
        </div>
      </header>

      {error !== null && (
        <p role="alert" className="border-b border-danger bg-danger-subtle p-3 text-sm">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'conversation' && snapshot !== null && (
          <>
            {snapshot.pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.approvalId}
                approval={approval}
                onAnswer={async (optionId) => {
                  await app.session?.send({
                    op: 'approval.respond',
                    sessionId,
                    approvalId: approval.approvalId,
                    optionId,
                  })
                  await load()
                }}
                error={setError}
              />
            ))}
            {snapshot.pendingInputs.map((input) => (
              <QuestionCard
                key={input.inputId}
                input={input}
                onAnswer={async (value) => {
                  await app.session?.send({
                    op: 'input.respond',
                    sessionId,
                    inputId: input.inputId,
                    value,
                  })
                  await load()
                }}
                error={setError}
              />
            ))}
            <Conversation messages={snapshot.messages} />
          </>
        )}

        {tab === 'changes' && <Changes />}

        {tab === 'details' && snapshot !== null && (
          <dl className="space-y-2 text-sm">
            <Row label="Provider" value={snapshot.session.driverKind} />
            <Row label="Model" value={snapshot.session.modelId ?? 'default'} />
            <Row label="Permission mode" value={snapshot.session.permissionMode} />
            <Row label="Status" value={snapshot.session.status} />
            <Row label="Project" value={snapshot.summary.projectId} />
            <Row label="Parent" value={snapshot.session.parentSessionId ?? 'top level'} />
            <Row label="Started" value={relativeTime(snapshot.session.createdAt)} />
            <Row label="Last update" value={relativeTime(snapshot.session.updatedAt)} />
          </dl>
        )}
      </div>

      <Composer
        disabled={!can('session.prompt') || snapshot === null}
        status={snapshot?.session.status ?? 'idle'}
        onSend={async (text, mode) => {
          const op =
            mode === 'queue' ? 'session.queue' : mode === 'steer' ? 'session.steer' : 'session.prompt'
          await app.session?.send({ op, sessionId, text })
          await load()
        }}
        onInterrupt={
          can('session.interrupt')
            ? async () => {
                await app.session?.send({ op: 'session.interrupt', sessionId })
                await load()
              }
            : null
        }
        onError={setError}
      />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex justify-between gap-3 border-b border-border pb-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="truncate text-right">{value}</dd>
    </div>
  )
}

/**
 * An approval, rendered from the options the provider actually offered.
 *
 * Several persistent grants stay several buttons: Codex advertises both a
 * session-scoped and a prefix-scoped "always allow", and collapsing them into
 * one would answer a question the user was never asked.
 */
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
    <section className="mb-3 rounded-lg border border-warning bg-warning-subtle p-3">
      <h3 className="text-sm font-medium">Approval needed · {approval.toolName}</h3>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-2 font-mono text-2xs text-fg-muted">
        {summarizeToolDetail(approval.summaryJson)}
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
            className="min-h-11 w-full rounded-md border border-border bg-surface-1 px-3 text-left text-sm disabled:opacity-50"
          >
            {option.name}
            {option.kind !== null && (
              <span className="ml-2 text-2xs text-fg-subtle">{option.kind}</span>
            )}
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
  const choices: string[] = parseChoices(input.choicesJson)

  return (
    <section className="mb-3 rounded-lg border border-info bg-info-subtle p-3">
      <h3 className="text-sm font-medium">The agent is asking</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm">{input.prompt}</p>
      {choices.length > 0 ? (
        <div className="mt-3 space-y-2">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() =>
                void onAnswer(choice).catch((failure: unknown) => error(messageOf(failure)))
              }
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
            void onAnswer(value).catch((failure: unknown) => error(messageOf(failure)))
            setValue('')
          }}
        >
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Your answer"
            className="h-11 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3"
          />
          <button type="submit" className="h-11 rounded-md bg-accent px-3 text-fg-on-accent">
            Answer
          </button>
        </form>
      )}
    </section>
  )
}

function Conversation({ messages }: { messages: Message[] }): ReactNode {
  if (messages.length === 0) {
    return <p className="text-sm text-fg-muted">Nothing has been said yet.</p>
  }
  return (
    <ol className="space-y-3">
      {messages.map((message) => (
        <li
          key={message.id}
          className={`rounded-lg border p-3 ${
            message.role === 'user'
              ? 'border-accent bg-accent-subtle'
              : 'border-border bg-surface-1'
          }`}
        >
          <p className="mb-1 text-2xs uppercase tracking-wide text-fg-subtle">
            {message.role}
            {message.origin?.kind === 'session' && ' · from another session'}
          </p>
          {message.parts.map((part, index) => (
            <p
              key={`${message.id}-${index}`}
              className={
                part.type === 'text'
                  ? 'whitespace-pre-wrap text-sm'
                  : 'font-mono text-2xs text-fg-subtle'
              }
            >
              {part.type === 'text'
                ? part.text
                : part.type === 'tool-call'
                  ? `↳ ${part.name}`
                  : part.type === 'tool-result'
                    ? '↳ result'
                    : part.type === 'thinking'
                      ? '↳ thinking'
                      : '↳ image'}
            </p>
          ))}
        </li>
      ))}
    </ol>
  )
}

/**
 * Changes: whether this can be answered at all is the desktop's to say.
 *
 * No desktop serves a per-file change list yet — the only integration that
 * exists is the agent-to-agent one, which the remote surface deliberately
 * keeps off — so this says so rather than showing an empty list that would
 * read as "nothing changed". The capability check is what makes that honest:
 * a desktop that starts serving it makes this screen work without an update.
 */
function Changes(): ReactNode {
  const app = useApp()
  if (!(app.session?.supports('changes.files') ?? false)) {
    return (
      <p className="text-sm text-fg-muted">
        This desktop does not offer a per-file change list for a session. Read the conversation for
        what the agent did, or review the changes on the computer.
      </p>
    )
  }
  return (
    <p className="text-sm text-fg-muted">
      This desktop can list changes, but this build has no view for them yet.
    </p>
  )
}

function Composer({
  disabled,
  status,
  onSend,
  onInterrupt,
  onError,
}: {
  disabled: boolean
  status: string
  onSend: (text: string, mode: 'send' | 'queue' | 'steer') => Promise<void>
  onInterrupt: (() => Promise<void>) | null
  onError: (message: string) => void
}): ReactNode {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const running = status === 'running'

  async function submit(mode: 'send' | 'queue' | 'steer'): Promise<void> {
    const value = text.trim()
    if (value.length === 0 || disabled) return
    setBusy(true)
    try {
      await onSend(value, mode)
      setText('')
    } catch (failure) {
      onError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="shrink-0 border-t border-border bg-surface-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit(running ? 'queue' : 'send')
      }}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={2}
        disabled={disabled}
        placeholder={disabled ? 'This desktop cannot take prompts' : 'Message the agent'}
        aria-label="Message the agent"
        className="w-full resize-none rounded-md border border-border bg-surface-1 p-3 text-fg placeholder:text-fg-subtle disabled:opacity-50"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="submit"
          disabled={disabled || busy}
          className="h-11 flex-1 rounded-md bg-accent px-3 text-fg-on-accent disabled:opacity-50"
        >
          {running ? 'Queue' : 'Send'}
        </button>
        {running && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit('steer')}
            className="h-11 rounded-md border border-border bg-surface-1 px-3 text-sm disabled:opacity-50"
          >
            Steer
          </button>
        )}
        {running && onInterrupt !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void onInterrupt().catch((failure: unknown) => onError(messageOf(failure)))
            }}
            className="h-11 rounded-md border border-danger px-3 text-sm text-danger disabled:opacity-50"
          >
            Interrupt
          </button>
        )}
      </div>
    </form>
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
