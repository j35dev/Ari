import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Textarea } from '@ari/ui/textarea'
import { attachmentRefSchema, MAX_ATTACHMENTS } from '@ari/contracts/attachments'
import { machineEventsFrameSchema, type MachineView } from '@ari/contracts/machines'
import {
  remoteAttachmentSchema,
  remoteSessionResultSchema,
  type RemoteSessionResult,
  MAX_REMOTE_IMAGE_BYTES,
} from '@ari/contracts/remote'
import type { MessagePart } from '@ari/contracts/message'
import { rpc } from '../../lib/rpc'
import { QuestionPanel } from '../approvals/QuestionPanel'
import { MarkdownBlock } from '../transcript/MarkdownBlock'
import { machineCan } from './use-machines'
import {
  messageOf,
  readReceipt,
  remoteQuery,
  resolveReceipt,
  sendRemote,
  type RemoteAction,
} from './remote-client'
import { readRemoteDraft, writeRemoteDraft, type RemoteDraft } from './remote-drafts'
import { RemoteFiles, RemoteChanges } from './RemoteTools'
import { RemoteTerminal } from './RemoteTerminal'
import { RemoteConfiguration, useRemoteCatalog, type RemoteSelection } from './RemoteConfiguration'

const stagedSchema = z.object({ attachments: attachmentRefSchema.array() })
const forkedSchema = z.object({ child: z.object({ id: z.string().min(1) }) })

export function RemoteSession({
  machine,
  sessionId,
  onOpenSession,
}: {
  machine: MachineView
  sessionId: string
  onOpenSession: (id: string) => void
}) {
  const [snapshot, setSnapshot] = useState<RemoteSessionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(() => readReceipt(machine.id, sessionId))
  const [view, setView] = useState<'chat' | 'changes' | 'files' | 'terminal' | 'details'>('chat')
  const [composerEpoch, setComposerEpoch] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [showLatest, setShowLatest] = useState(false)
  const cursor = useRef<number | undefined>(undefined)
  const loading = useRef(false)
  const alive = useRef(true)
  const machineRef = useRef(machine)
  machineRef.current = machine
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const load = useCallback(async () => {
    if (!machineCan(machineRef.current, 'session.get') || loading.current) return
    loading.current = true
    try {
      const result = remoteSessionResultSchema.parse(
        await remoteQuery(machine.id, { op: 'session.get', sessionId }),
      )
      if (!alive.current) return
      if (
        result.session.id !== sessionId ||
        result.summary.id !== sessionId ||
        result.messages.some((message) => message.sessionId !== sessionId)
      )
        throw new Error('The host returned a different session.')
      cursor.current = result.seq
      setSnapshot(result)
      setError(null)
    } catch (error) {
      if (alive.current) setError(messageOf(error))
    } finally {
      loading.current = false
    }
  }, [machine.id, sessionId])
  useEffect(() => {
    void load()
  }, [load, machine.status])
  const loaded = snapshot !== null
  useEffect(() => {
    if (!loaded || !machineCan(machine, 'events.subscribe')) return
    let closed = false
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = rpc.subscribe(
      'machines.events',
      { machineId: machine.id, sessionId, fromSeq: cursor.current },
      (raw) => {
        const frame = machineEventsFrameSchema.safeParse(raw)
        if (closed || !frame.success || frame.data.machineId !== machine.id) return
        const message = frame.data.message
        if (message.type === 'error') {
          setError(message.error.message)
          return
        }
        if (message.sessionId !== sessionId || scheduled !== undefined) return
        scheduled = setTimeout(() => {
          scheduled = undefined
          void load()
        }, 350)
      },
    )
    return () => {
      closed = true
      unsubscribe()
      if (scheduled !== undefined) clearTimeout(scheduled)
    }
  }, [loaded, machine.id, machine.status, sessionId, load])
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5000)
    return () => clearInterval(timer)
  }, [load])
  const finish = (action: RemoteAction, result: unknown) => {
    if (
      action.op === 'session.prompt' ||
      action.op === 'session.queue' ||
      action.op === 'session.steer'
    ) {
      const draft = readRemoteDraft(machine.id, sessionId)
      const sentIds = action.op === 'session.steer' ? [] : (action.attachmentIds ?? [])
      if (
        draft.text === action.text &&
        JSON.stringify(draft.attachments.map((item) => item.id)) === JSON.stringify(sentIds)
      )
        writeRemoteDraft(machine.id, sessionId, { text: '', attachments: [] })
      setComposerEpoch((value) => value + 1)
    }
    if (action.op === 'attachments.stage') {
      const draft = readRemoteDraft(machine.id, sessionId)
      writeRemoteDraft(machine.id, sessionId, {
        ...draft,
        attachments: [...draft.attachments, ...stagedSchema.parse(result).attachments].slice(
          0,
          MAX_ATTACHMENTS,
        ),
      })
      setComposerEpoch((value) => value + 1)
    }
    if (action.op === 'session.fork') onOpenSession(forkedSchema.parse(result).child.id)
  }
  async function act(action: RemoteAction): Promise<void> {
    if (!alive.current || busy || !machineCan(machineRef.current, action.op))
      throw new Error('Reconnect to the host before this action.')
    setBusy(true)
    setError(null)
    const actionScope = 'sessionId' in action ? action.sessionId : sessionId
    try {
      const result = await sendRemote(machine.id, actionScope, action)
      if (!alive.current) return
      finish(action, result)
      await load()
    } catch (error) {
      if (alive.current) setError(messageOf(error))
      throw error
    } finally {
      if (alive.current) {
        setBusy(false)
        setPending(readReceipt(machine.id, actionScope) ?? readReceipt(machine.id, sessionId))
      }
    }
  }
  function run(action: RemoteAction): void {
    void act(action).catch(() => undefined)
  }
  async function reconcile(retry: boolean): Promise<void> {
    if (!pending || busy || machine.status !== 'connected') return
    setBusy(true)
    try {
      const result = await resolveReceipt(machine.id, pending.scope, retry)
      if (!alive.current) return
      finish(pending.command, result)
      setError(null)
      await load()
    } catch (error) {
      if (alive.current) setError(messageOf(error))
    } finally {
      if (alive.current) {
        setPending(readReceipt(machine.id, pending.scope))
        setBusy(false)
      }
    }
  }
  const can = (op: string) => !busy && !pending && machineCan(machine, op)
  const blocked = !can('session.prompt')
  const terminalGranted = machine.allowTerminal && machineCan(machine, 'terminal.create')
  const activeView = view === 'terminal' && !terminalGranted ? 'chat' : view
  const scrollToLatest = useCallback(() => {
    if (scroll.current && follow.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [])
  useLayoutEffect(scrollToLatest, [snapshot, activeView, scrollToLatest])
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scrollToLatest)
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [activeView, scrollToLatest])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {snapshot?.session.title ?? 'Remote session'}
          </h1>
          <p className="text-xs text-fg-muted">
            {snapshot?.session.driverKind ?? 'Host agent'} · {snapshot?.session.status ?? 'Loading'}
            {snapshot?.session.effort ? ` · ${snapshot.session.effort}` : ''}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={machine.status !== 'connected'}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!can('session.interrupt')}
          onClick={() => run({ op: 'session.interrupt', sessionId })}
        >
          Stop
        </Button>
      </header>
      <nav
        aria-label="Remote session tools"
        className="flex shrink-0 gap-1 border-b border-border px-5 py-2"
      >
        {(
          [
            'chat',
            'changes',
            'files',
            ...(terminalGranted ? (['terminal'] as const) : []),
            'details',
          ] as const
        ).map((tab) => (
          <Button
            key={tab}
            size="sm"
            variant={activeView === tab ? 'secondary' : 'ghost'}
            aria-pressed={activeView === tab}
            onClick={() => setView(tab)}
          >
            {tab === 'chat' ? 'Conversation' : tab.charAt(0).toUpperCase() + tab.slice(1)}
          </Button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="shrink-0 border-b border-border px-5 py-3 text-sm text-danger">
          {error}
        </p>
      )}
      {pending && (
        <section
          aria-label="Unconfirmed remote action"
          className="shrink-0 border-b border-warning/40 bg-surface-1 px-5 py-3"
        >
          <p className="text-sm text-warning">
            Unconfirmed {pending.command.op} on {machine.name}. The exact action and receipt are
            saved.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy || machine.status !== 'connected'}
              onClick={() => void reconcile(false)}
            >
              Check receipt
            </Button>
            <Button
              size="sm"
              disabled={busy || machine.status !== 'connected'}
              onClick={() => void reconcile(true)}
            >
              Retry saved action
            </Button>
          </div>
        </section>
      )}
      {activeView === 'chat' ? (
        <>
          <div ref={scroll} aria-label="Remote transcript" className="ari-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5" onScroll={(event) => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; setShowLatest(!follow.current) }}>
            <div ref={content} className="mx-auto max-w-3xl space-y-5">
              {snapshot?.parent && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpenSession(snapshot.parent!.id)}
                >
                  Parent: {snapshot.parent.title}
                </Button>
              )}
              {snapshot?.messages.map((message) => (
                <article
                  key={message.id}
                  className={
                    message.role === 'user'
                      ? 'rounded-lg border border-border bg-surface-1 p-4'
                      : 'px-1'
                  }
                >
                  <p className="mb-2 text-xs font-medium text-fg-subtle">
                    {message.role === 'user'
                      ? 'You'
                      : message.role === 'assistant'
                        ? snapshot.session.driverKind
                        : 'Ari'}
                  </p>
                  {message.parts.map((part, index) => (
                    <RemotePart key={index} machine={machine} sessionId={sessionId} part={part} />
                  ))}
                </article>
              ))}
              {snapshot && snapshot.messages.length === 0 && (
                <p className="py-12 text-center text-sm text-fg-subtle">
                  Send a prompt to start work on {machine.name}.
                </p>
              )}
              {snapshot?.tasks?.length ? (
                <section aria-label="Host agents" className="rounded-lg border border-border p-4">
                  <h2 className="mb-2 text-sm font-medium">Agents on {machine.name}</h2>
                  {snapshot.tasks.map((task) => (
                    <div key={task.sessionId} className="flex items-center gap-2 py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onOpenSession(task.sessionId)}
                      >
                        {task.title}
                      </Button>
                      <span className="text-xs text-fg-muted">
                        {task.workState.replaceAll('_', ' ')}
                      </span>
                      <Button
                        size="sm"
                        className="ml-auto"
                        disabled={!can('session.interrupt')}
                        onClick={() => run({ op: 'session.interrupt', sessionId: task.sessionId })}
                      >
                        Stop agent
                      </Button>
                    </div>
                  ))}
                </section>
              ) : null}
            </div>
          </div>
          {showLatest && <div className="flex shrink-0 justify-center pb-2"><Button size="sm" onClick={() => { follow.current = true; setShowLatest(false); scrollToLatest() }}>Latest messages</Button></div>}
          {(snapshot?.pendingApprovals.length ?? 0) + (snapshot?.pendingInputs.length ?? 0) > 0 && (
            <section
              aria-label="Host requests"
              className="ari-scroll max-h-[45vh] shrink-0 overflow-y-auto border-t border-border px-6 py-4"
            >
              <div className="mx-auto max-w-3xl space-y-3">
                {snapshot?.pendingApprovals.map((approval) => (
                  <div
                    key={approval.approvalId}
                    className="rounded-lg border border-warning/40 bg-surface-1 p-4"
                  >
                    <h2 className="text-sm font-medium">{approval.toolName}</h2>
                    <pre className="my-3 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-fg-muted">
                      {approval.summaryJson}
                    </pre>
                    <div className="flex flex-wrap gap-2">
                      {approval.options.map((option) => (
                        <Button
                          key={option.optionId}
                          size="sm"
                          disabled={!can('approval.respond')}
                          onClick={() =>
                            run({
                              op: 'approval.respond',
                              sessionId,
                              approvalId: approval.approvalId,
                              optionId: option.optionId,
                            })
                          }
                        >
                          {option.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
                {snapshot?.pendingInputs.map((input) => (
                  <fieldset
                    key={input.inputId}
                    disabled={!can('input.respond')}
                    className="rounded-lg border border-warning/40 bg-surface-1 p-4"
                  >
                    <QuestionPanel
                      prompt={input.prompt}
                      choicesJson={input.choicesJson}
                      onRespond={(value) =>
                        run({ op: 'input.respond', sessionId, inputId: input.inputId, value })
                      }
                    />
                  </fieldset>
                ))}
              </div>
            </section>
          )}
          <RemoteComposer
            key={composerEpoch}
            machine={machine}
            sessionId={sessionId}
            disabled={blocked}
            can={can}
            onSend={act}
          />
        </>
      ) : activeView === 'changes' ? (
        <RemoteChanges
          machine={machine}
          sessionId={sessionId}
          onAction={act}
          disabled={busy || pending !== null}
        />
      ) : activeView === 'files' ? (
        <RemoteFiles machine={machine} sessionId={sessionId} />
      ) : activeView === 'terminal' ? (
        <RemoteTerminal machine={machine} sessionId={sessionId} />
      ) : snapshot ? (
        <RemoteDetails
          machine={machine}
          snapshot={snapshot}
          disabled={busy || pending !== null}
          onAction={act}
        />
      ) : null}
    </div>
  )
}

function RemotePart({
  machine,
  sessionId,
  part,
}: {
  machine: MachineView
  sessionId: string
  part: MessagePart
}) {
  if (part.type === 'text')
    return (
      <div className="text-sm leading-relaxed">
        <MarkdownBlock text={part.text} />
      </div>
    )
  if (part.type === 'image')
    return (
      <RemoteImage
        machine={machine}
        sessionId={sessionId}
        attachmentId={part.attachmentId}
        name={part.name}
      />
    )
  return (
    <details className="my-2 rounded-md border border-border p-2 text-xs text-fg-muted">
      <summary>
        {part.type === 'thinking'
          ? 'Reasoning'
          : part.type === 'tool-call'
            ? part.name
            : part.isError
              ? 'Tool error'
              : 'Tool result'}
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">
        {part.type === 'thinking'
          ? part.text
          : part.type === 'tool-call'
            ? part.argsJson
            : part.resultJson}
      </pre>
    </details>
  )
}

function RemoteImage({
  machine,
  sessionId,
  attachmentId,
  name,
}: {
  machine: MachineView
  sessionId: string
  attachmentId: string
  name: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (machineCan(machine, 'attachments.read'))
      void remoteQuery(machine.id, { op: 'attachments.read', sessionId, attachmentId })
        .then((raw) => {
          const result = remoteAttachmentSchema.parse(raw)
          if (
            alive &&
            result.attachment &&
            /^image\/(png|jpeg|gif|webp)$/.test(result.attachment.mimeType)
          )
            setUrl(`data:${result.attachment.mimeType};base64,${result.attachment.dataBase64}`)
        })
        .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [machine.id, machine.status, sessionId, attachmentId])
  return url ? (
    <img src={url} alt={name} className="my-2 max-h-64 max-w-full rounded-md" />
  ) : (
    <p className="my-2 text-xs text-fg-muted">
      Image on {machine.name}: {name}
    </p>
  )
}

function RemoteComposer({
  machine,
  sessionId,
  disabled,
  can,
  onSend,
}: {
  machine: MachineView
  sessionId: string
  disabled: boolean
  can: (op: string) => boolean
  onSend: (action: RemoteAction) => Promise<void>
}) {
  const [draft, setDraft] = useState<RemoteDraft>(() => readRemoteDraft(machine.id, sessionId))
  const [error, setError] = useState<string | null>(null)
  const update = (next: RemoteDraft) => {
    setDraft(next)
    try {
      writeRemoteDraft(machine.id, sessionId, next)
      setError(null)
    } catch {
      setError('Could not preserve this draft. Free browser storage before sending.')
    }
  }
  const send = (op: 'session.prompt' | 'session.queue' | 'session.steer') => {
    if ((!draft.text.trim() && draft.attachments.length === 0) || error || !can(op)) return
    void onSend({
      op,
      sessionId,
      text: draft.text,
      ...(op === 'session.steer' || draft.attachments.length === 0
        ? {}
        : { attachmentIds: draft.attachments.map((item) => item.id) }),
    }).catch(() => undefined)
  }
  async function stage(file: File): Promise<void> {
    if (file.size > MAX_REMOTE_IMAGE_BYTES || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      setError('Choose a PNG, JPEG, GIF, or WebP image up to 1 MiB.')
      return
    }
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') { reject(new Error('The image could not be read.')); return }
        resolve(reader.result.split(',')[1] ?? '')
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    await onSend({
      op: 'attachments.stage',
      sessionId,
      files: [
        {
          name: file.name,
          mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          dataBase64: data,
        },
      ],
    })
  }
  return (
    <form
      className="shrink-0 border-t border-border px-6 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        send('session.prompt')
      }}
    >
      <div className="mx-auto max-w-3xl">
        <Textarea
          aria-label={`Prompt on ${machine.name}`}
          value={draft.text}
          onChange={(event) => update({ ...draft, text: event.target.value })}
          placeholder={`Message the agent on ${machine.name}…`}
          className="min-h-24 w-full resize-y"
          disabled={disabled && machine.status === 'connected'}
        />
        {draft.attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            className="mr-2 mt-2 rounded-md bg-surface-2 px-2 py-1 text-xs"
            disabled={disabled}
            aria-label={`Remove ${attachment.name}`}
            onClick={() =>
              update({
                ...draft,
                attachments: draft.attachments.filter((row) => row.id !== attachment.id),
              })
            }
          >
            {attachment.name} ×
          </button>
        ))}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="mr-auto text-xs text-fg-muted">
            {machine.name} · Host workspace
            <input
              type="file"
              aria-label="Attach image to host session"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="mt-1 block max-w-48 text-xs"
              disabled={!can('attachments.stage') || draft.attachments.length >= MAX_ATTACHMENTS}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void stage(file).catch((error: unknown) => setError(messageOf(error)))
              }}
            />
          </label>
          <Button
            size="sm"
            disabled={
              !can('session.steer') ||
              !draft.text.trim() ||
              draft.attachments.length > 0 ||
              error !== null
            }
            onClick={() => send('session.steer')}
          >
            Steer
          </Button>
          <Button
            size="sm"
            disabled={
              !can('session.queue') ||
              (!draft.text.trim() && !draft.attachments.length) ||
              error !== null
            }
            onClick={() => send('session.queue')}
          >
            Queue
          </Button>
          <Button
            size="sm"
            type="submit"
            variant="primary"
            disabled={
              disabled || (!draft.text.trim() && !draft.attachments.length) || error !== null
            }
          >
            Send
          </Button>
        </div>
      </div>
    </form>
  )
}

function RemoteDetails({
  machine,
  snapshot,
  disabled,
  onAction,
}: {
  machine: MachineView
  snapshot: RemoteSessionResult
  disabled: boolean
  onAction: (action: RemoteAction) => Promise<void>
}) {
  const { session } = snapshot
  const { catalog } = useRemoteCatalog(machine)
  const [title, setTitle] = useState(session.title)
  const [pinned, setPinned] = useState(session.pinned ?? false)
  const [forkTitle, setForkTitle] = useState('')
  const [archive, setArchive] = useState(false)
  const [selection, setSelection] = useState<RemoteSelection>({
    driverKind: session.driverKind,
    modelId: session.modelId ?? '',
    permissionMode: session.permissionMode,
    effort: session.effort ?? null,
  })
  const run = (action: RemoteAction) => void onAction(action).catch(() => undefined)
  return (
    <div className="ari-scroll min-h-0 flex-1 overflow-y-auto p-8">
      <div className="mx-auto max-w-xl space-y-5">
        <h2 className="text-lg font-semibold">Session details on {machine.name}</h2>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            run({
              op: 'session.update',
              sessionId: session.id,
              title: title.trim(),
              pinned,
              modelId: selection.modelId || null,
              permissionMode: selection.permissionMode,
              effort: selection.effort,
            })
          }}
        >
          <label className="block text-xs text-fg-muted">
            Session name
            <Input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 w-full"
            />
          </label>
          {catalog && (
            <RemoteConfiguration
              machine={machine}
              catalog={catalog}
              value={selection}
              onChange={setSelection}
              fixedProvider
              disabled={disabled || session.status === 'running'}
            />
          )}
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            Pin session
          </label>
          <Button
            type="submit"
            disabled={disabled || !machineCan(machine, 'session.update') || !title.trim()}
          >
            Save on host
          </Button>
        </form>
        <form
          className="space-y-2 border-t border-border pt-5"
          onSubmit={(event) => {
            event.preventDefault()
            run({ op: 'session.fork', sessionId: session.id, title: forkTitle.trim() })
          }}
        >
          <label className="block text-xs text-fg-muted">
            Fork name
            <Input
              className="mt-1 w-full"
              value={forkTitle}
              maxLength={120}
              onChange={(event) => setForkTitle(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            disabled={disabled || !machineCan(machine, 'session.fork') || !forkTitle.trim()}
          >
            Fork on host
          </Button>
        </form>
        {archive ? (
          <div role="alertdialog" aria-label="Archive remote session">
            <p className="mb-2 text-sm">Archive this session on {machine.name}?</p>
            <Button
              variant="danger"
              disabled={disabled || !machineCan(machine, 'session.archive')}
              onClick={() => run({ op: 'session.archive', sessionId: session.id })}
            >
              Confirm archive
            </Button>
            <Button className="ml-2" onClick={() => setArchive(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            disabled={!machineCan(machine, 'session.archive')}
            onClick={() => setArchive(true)}
          >
            Archive session
          </Button>
        )}
      </div>
    </div>
  )
}
