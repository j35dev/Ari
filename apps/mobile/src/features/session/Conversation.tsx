import { useEffect, useState, type ReactNode } from 'react'
import { Copy, Check } from 'lucide-react'
import type { Message } from '@ari/contracts/message'
import type { z } from 'zod'
import type { remoteAttachmentSchema } from '@ari/contracts/remote'
import { Markdown } from '../../components/Markdown'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { formatClock } from '../../lib/format'
import { conversationBlocks, conversationParts } from '../../lib/conversation-parts'
import { ActivityRun } from './ActivityRun'

/** A pause this long between messages is worth marking with the time. */
const PAUSE_MS = 10 * 60 * 1000

/** The user's words in bubbles, the agent's unboxed, and its work as one-line steps between. */
export function Conversation({
  messages,
  sessionId,
  running = false,
}: {
  messages: Message[]
  sessionId: string
  /** Whether the agent is working, which keeps its newest run of steps open. */
  running?: boolean
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
            {message.origin?.kind === 'session' && (
              <p className="mb-1 text-[11px] text-fg-subtle">From a linked session</p>
            )}
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
