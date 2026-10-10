import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, CornerDownRight } from 'lucide-react'
import type { Message } from '@ari/contracts/message'
import type { z } from 'zod'
import type { remoteAttachmentSchema } from '@ari/contracts/remote'
import { Markdown } from '../../components/Markdown'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { formatClock } from '../../lib/format'
import { conversationBlocks, conversationParts } from '../../lib/conversation-parts'
import { delegationUpdate } from '../../lib/delegation'
import { ActivityRun } from './ActivityRun'

/** A pause this long between messages is worth marking with the time. */
const PAUSE_MS = 10 * 60 * 1000

/** The user's words in bubbles, the agent's unboxed, and its work as one-line steps between. */
export function Conversation({
  messages,
  sessionId,
  running = false,
  titleOf,
  onOpenSession,
}: {
  messages: Message[]
  sessionId: string
  /** Whether the agent is working, which keeps its newest run of steps open. */
  running?: boolean
  /** The current title of another session, for naming who sent a relayed message. */
  titleOf?: (sessionId: string) => string | undefined
  onOpenSession?: (sessionId: string) => void
}): ReactNode {
  if (messages.length === 0)
    return (
      <EmptyState
        title="What should we work on?"
        detail="Describe a task, ask a question, or attach a reference. The agent works inside this project on your computer."
      />
    )
  return (
    <ol className="space-y-5">
      {messages.map((message, index) => {
        const presentation = conversationParts(message.parts)
        const blocks = conversationBlocks(presentation.parts)
        const previous = messages[index - 1]
        const user = message.role === 'user'
        if (user && message.origin?.kind === 'completion')
          return (
            <li key={message.id} data-role="notice" className="w-full min-w-0">
              <DelegationUpdate
                text={presentation.copyText}
                sessionIds={message.origin.sessionIds}
                titleOf={titleOf}
                onOpenSession={onOpenSession}
              />
            </li>
          )
        const sender = message.origin?.kind === 'session' ? message.origin.sessionId : null
        const senderTitle = sender === null ? undefined : titleOf?.(sender)
        return (
          <li
            key={message.id}
            data-role={message.role}
            className={user ? 'flex w-full min-w-0 flex-col items-end' : 'w-full min-w-0'}
          >
            {(previous === undefined || message.createdAt - previous.createdAt > PAUSE_MS) && (
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
                user
                  ? 'message-bubble max-w-[85%] rounded-[20px] bg-surface-2 px-3.5 py-2.5'
                  : 'min-w-0'
              }
            >
              {blocks.map((block, position) =>
                block.kind === 'content' ? (
                  <Part
                    key={`${message.id}:${block.sourceIndex}`}
                    part={block.part}
                    sessionId={sessionId}
                  />
                ) : (
                  <ActivityRun
                    key={`${message.id}:${block.sourceIndex}`}
                    parts={block.parts}
                    live={
                      running && index === messages.length - 1 && position === blocks.length - 1
                    }
                  />
                ),
              )}
            </div>
            {message.role === 'assistant' &&
              presentation.copyText.trim() !== '' &&
              !(running && index === messages.length - 1) && (
                <CopyMessage text={presentation.copyText} />
              )}
          </li>
        )
      })}
    </ol>
  )
}

function Part({
  part,
  sessionId,
}: {
  part: Extract<Message['parts'][number], { type: 'text' | 'image' }>
  sessionId: string
}): ReactNode {
  if (part.type === 'text') return <Markdown text={part.text} />
  return <ImageAttachment sessionId={sessionId} id={part.attachmentId} name={part.name} />
}
/**
 * A wake-up Ari wrote for this session when delegated agents finished. Nobody
 * typed it, so it is not a bubble: one line says who reported, and the text
 * the agent was given opens underneath for whoever wants it.
 */
function DelegationUpdate({
  text,
  sessionIds,
  titleOf,
  onOpenSession,
}: {
  text: string
  sessionIds: readonly string[]
  titleOf: ((sessionId: string) => string | undefined) | undefined
  onOpenSession: ((sessionId: string) => void) | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const update = delegationUpdate(text, sessionIds, (id) => titleOf?.(id))
  return (
    <div className="rounded-xl bg-surface-1">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Delegation update: ${update.headline}`}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-xs text-fg-muted"
        onClick={() => setOpen((shown) => !shown)}
      >
        <CornerDownRight size={14} aria-hidden className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{update.headline}</span>
        <ChevronDown
          size={14}
          aria-hidden
          className={`shrink-0 text-fg-subtle transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="px-3 pb-3">
          {onOpenSession !== undefined && (
            <p className="flex flex-wrap gap-2 pb-2">
              {sessionIds.map((id) => {
                const title = titleOf?.(id)
                return title === undefined ? null : (
                  <button
                    key={id}
                    type="button"
                    className="min-h-9 rounded-full border border-border px-3 text-xs text-fg-muted"
                    onClick={() => onOpenSession(id)}
                  >
                    Open {title}
                  </button>
                )
              })}
            </p>
          )}
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg-muted">
            {update.body}
          </p>
        </div>
      )}
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
