import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import type { Message } from '@ari/contracts/message'
import { parseSlashCommand } from '@ari/contracts/slash-commands'
import type { z } from 'zod'
import type { remoteAttachmentSchema } from '@ari/contracts/remote'
import { Markdown } from '../../components/Markdown'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { formatClock } from '../../lib/format'
import { conversationBlocks, conversationParts } from '../../lib/conversation-parts'
import { ActivityRun } from './ActivityRun'
import type { OutboxEntry } from './Composer'

/** A pause this long between messages is worth marking with the time. */
const PAUSE_MS = 10 * 60 * 1000

/** The user's words in bubbles, the agent's unboxed, and its work as one-line steps between. */
export function Conversation({
  messages,
  sessionId,
  running = false,
  titleOf,
  onOpenSession,
  outbox = null,
}: {
  messages: Message[]
  sessionId: string
  /** Whether the agent is working, which keeps its newest run of steps open. */
  running?: boolean
  /** The current title of another session, for naming who sent a relayed message. */
  titleOf?: (sessionId: string) => string | undefined
  onOpenSession?: (sessionId: string) => void
  /** A message sent from this phone that the conversation does not show yet. */
  outbox?: OutboxEntry | null
}): ReactNode {
  if (messages.length === 0 && outbox === null)
    return (
      <EmptyState
        title="What should we work on?"
        detail="Describe a task, ask a question, or attach a reference. The agent works inside this project on your computer."
      />
    )
  return (
    <ol className="space-y-5">
      {messages.map((message, index) => {
        const previous = messages[index - 1]
        return (
          <MessageItem
            key={message.id}
            message={message}
            sessionId={sessionId}
            showTime={previous === undefined || message.createdAt - previous.createdAt > PAUSE_MS}
            active={running && index === messages.length - 1}
            titleOf={titleOf}
            onOpenSession={onOpenSession}
          />
        )
      })}
      {outbox !== null && <Outgoing entry={outbox} />}
    </ol>
  )
}

/** The phone's own message, before the computer's copy arrives. */
function Outgoing({ entry }: { entry: OutboxEntry }): ReactNode {
  return (
    <li
      data-role="user"
      data-outbox={entry.state}
      className="flex w-full min-w-0 flex-col items-end"
    >
      <div
        className={`message-bubble max-w-[85%] rounded-[20px] bg-surface-2 px-3.5 py-2.5 transition-opacity ${entry.state === 'sending' ? 'opacity-70' : ''}`}
      >
        <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.6]">{entry.text}</p>
      </div>
      <p
        role="status"
        className={`mt-1 text-[11px] ${entry.state === 'uncertain' ? 'text-warning' : 'text-fg-subtle'}`}
      >
        {entry.state === 'sending'
          ? 'Sending…'
          : entry.state === 'accepted'
            ? 'Sent'
            : 'Not confirmed. Check its receipt below before sending again.'}
      </p>
    </li>
  )
}

const MessageItem = memo(function MessageItem({
  message,
  sessionId,
  showTime,
  active,
  titleOf,
  onOpenSession,
}: {
  message: Message
  sessionId: string
  showTime: boolean
  /** The newest message while the agent works: its last block is still streaming. */
  active: boolean
  titleOf: ((sessionId: string) => string | undefined) | undefined
  onOpenSession: ((sessionId: string) => void) | undefined
}): ReactNode {
  const presentation = useMemo(() => conversationParts(message.parts), [message.parts])
  const blocks = useMemo(() => conversationBlocks(presentation.parts), [presentation])
  const user = message.role === 'user'
  // The parent agent still receives these wakes. They are not part of the chat.
  if (
    user &&
    (message.origin?.kind === 'completion' ||
      message.origin?.kind === 'question' ||
      message.origin?.kind === 'coordination')
  )
    return null
  const sender = message.origin?.kind === 'session' ? message.origin.sessionId : null
  const senderTitle = sender === null ? undefined : titleOf?.(sender)
  return (
    <li
      data-role={message.role}
      className={user ? 'flex w-full min-w-0 flex-col items-end' : 'w-full min-w-0'}
    >
      {showTime && (
        <time
          dateTime={new Date(message.createdAt).toISOString()}
          className="mb-3 block w-full text-center text-[11px] text-fg-subtle"
        >
          {formatClock(message.createdAt)}
        </time>
      )}
      {sender !== null &&
        (senderTitle !== undefined && onOpenSession !== undefined ? (
          <button
            type="button"
            className="mb-1 min-h-6 text-[11px] text-fg-subtle"
            onClick={() => onOpenSession(sender)}
          >
            From {senderTitle}
          </button>
        ) : (
          <p className="mb-1 text-[11px] text-fg-subtle">
            From {senderTitle ?? 'a linked session'}
          </p>
        ))}
      {message.role === 'system' && <p className="mb-1 text-[11px] text-fg-subtle">System</p>}
      <div
        className={
          user ? 'message-bubble max-w-[85%] rounded-[20px] bg-surface-2 px-3.5 py-2.5' : 'min-w-0'
        }
      >
        {blocks.map((block, position) =>
          block.kind === 'content' ? (
            <Part
              key={`${message.id}:${block.sourceIndex}`}
              part={block.part}
              user={user}
              sessionId={sessionId}
              streaming={active && !user && position === blocks.length - 1}
            />
          ) : (
            <ActivityRun
              key={`${message.id}:${block.sourceIndex}`}
              parts={block.parts}
              live={active && position === blocks.length - 1}
            />
          ),
        )}
      </div>
      {message.role === 'assistant' && presentation.copyText.trim() !== '' && !active && (
        <CopyMessage text={presentation.copyText} />
      )}
    </li>
  )
})

function Part({
  part,
  user = false,
  sessionId,
  streaming,
}: {
  part: Extract<Message['parts'][number], { type: 'text' | 'image' }>
  user?: boolean
  sessionId: string
  streaming: boolean
}): ReactNode {
  if (part.type === 'text') {
    const command = user ? parseSlashCommand(part.text) : null
    if (command) return <CommandChip name={command.name} args={command.args} />
    if (!user && NOTICE_MARKER.test(part.text))
      return <Notice text={part.text.replace(NOTICE_MARKER, '')} />
    return <Markdown text={part.text} streaming={streaming} />
  }
  return <ImageAttachment sessionId={sessionId} id={part.attachmentId} name={part.name} />
}
/** What Ari or a command reported, marked by the engine with a leading ℹ. */
const NOTICE_MARKER = /^\s*ℹ\s?/
const FOLD_CHARS = 400

/** A slash command the user sent: its name, then its arguments, folded when long. */
function CommandChip({ name, args }: { name: string; args: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const long = args.length > FOLD_CHARS || args.includes('\n')
  return (
    <p data-slash-command={name} className="whitespace-pre-wrap break-words text-[14px]">
      <span className="font-medium">/{name}</span>
      {args ? (
        <span className="text-fg-muted">
          {' '}
          {long && !open ? `${args.slice(0, FOLD_CHARS).split('\n')[0]}…` : args}
        </span>
      ) : null}
      {long ? (
        <button
          type="button"
          className="ml-1.5 text-[12px] text-fg-subtle underline"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </p>
  )
}

/** A notice row: muted, wrapped, and folded past a few lines. */
function Notice({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const body = text.trim()
  const long = body.length > FOLD_CHARS || body.split('\n').length > 6
  return (
    <div role="note" className="my-1 text-[13px] text-fg-muted">
      <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {long && !open ? `${body.split('\n').slice(0, 6).join('\n').slice(0, FOLD_CHARS)}…` : body}
      </p>
      {long ? (
        <button
          type="button"
          className="mt-0.5 text-[12px] text-fg-subtle underline"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  )
}

function CopyMessage({ text }: { text: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <button
      type="button"
      aria-label="Copy reply"
      className="-ml-3 flex size-11 items-center justify-center text-fg-subtle"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setState('copied'))
          .catch(() => setState('failed'))
      }}
    >
      {state === 'copied' ? <Check size={15} /> : <Copy size={15} />}
      {state === 'failed' && <span className="sr-only">Clipboard unavailable</span>}
    </button>
  )
}
function ImageAttachment({
  sessionId,
  id,
  name,
}: {
  sessionId: string
  id: string
  name: string
}): ReactNode {
  const app = useApp()
  const [image, setImage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    const session = app.session
    if (session === null || !session.supports('attachments.read')) return
    let cancelled = false
    void session
      .query<z.infer<typeof remoteAttachmentSchema>>('attachments.read', {
        sessionId,
        attachmentId: id,
      })
      .then((result) => {
        if (cancelled) return
        if (result.attachment === null) {
          setFailure(result.error ?? 'Image unavailable')
          return
        }
        if (
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
            result.attachment.mimeType,
          )
        ) {
          setFailure('Unsupported image format')
          return
        }
        setImage(`data:${result.attachment.mimeType};base64,${result.attachment.dataBase64}`)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : 'Image unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [app.session, sessionId, id])
  return image === null ? (
    <p className="py-2 text-xs text-fg-muted">
      {name} · {failure ?? 'Loading image…'}
    </p>
  ) : (
    <figure className="my-2">
      <img
        src={image}
        alt={name}
        loading="lazy"
        className="max-h-96 max-w-full rounded-xl border border-border object-contain"
      />
      <figcaption className="mt-1 text-[11px] text-fg-subtle">{name}</figcaption>
    </figure>
  )
}
