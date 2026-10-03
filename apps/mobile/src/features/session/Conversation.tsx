import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, Copy, Check, Terminal, Sparkles } from 'lucide-react'
import type { Message } from '@ari/contracts/message'
import type { z } from 'zod'
import type { remoteAttachmentSchema } from '@ari/contracts/remote'
import { Markdown } from '../../components/Markdown'
import { EmptyState } from '../../components/EmptyState'
import { useApp } from '../../lib/app-state'
import { formatClock } from '../../lib/format'
import { conversationBlocks, conversationParts } from '../../lib/conversation-parts'

/** Conversation parts retain tool output, reasoning, and authorized image previews. */
export function Conversation({
  messages,
  sessionId,
}: {
  messages: Message[]
  sessionId: string
}): ReactNode {
  if (messages.length === 0)
    return (
      <EmptyState
        title="Let's build something"
        detail="Describe a task, ask a question, or attach a reference. The agent works inside this project's workspace."
      />
    )
  return (
    <ol className="space-y-7">
      {messages.map((message) => {
        const presentation = conversationParts(message.parts)
        return (
          <li
            key={message.id}
            className={
              message.role === 'user' ? 'flex w-full min-w-0 flex-col items-end' : 'w-full min-w-0'
            }
          >
            <div
              className={`mb-2 flex items-center gap-2 text-[11px] text-fg-subtle ${message.role === 'user' ? 'justify-end' : ''}`}
            >
              {message.role !== 'user' && (
                <span className="flex size-5 items-center justify-center rounded-md bg-surface-2 font-semibold text-fg">
                  a
                </span>
              )}
              <span className="font-medium text-fg-muted">
                {message.role === 'user' ? 'You' : message.role === 'system' ? 'System' : 'Ari'}
              </span>
              <span>{formatClock(message.createdAt)}</span>
              {message.origin?.kind === 'session' && <span>· Linked session</span>}
            </div>
            <div
              className={
                message.role === 'user'
                  ? 'max-w-[92%] rounded-2xl rounded-tr-md bg-surface-2 px-4 py-3'
                  : 'min-w-0'
              }
            >
              {conversationBlocks(presentation.parts).map((block) =>
                block.kind === 'content' ? (
                  <Part
                    key={`${message.id}:${block.sourceIndex}`}
                    part={block.part}
                    sessionId={sessionId}
                  />
                ) : (
                  <details key={`${message.id}:${block.sourceIndex}`} className="my-3">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-fg-muted">
                      <ChevronRight size={14} />
                      Agent activity
                    </summary>
                    {block.parts.map(({ part, sourceIndex }) => (
                      <Part
                        key={`${message.id}:${sourceIndex}`}
                        part={part}
                        sessionId={sessionId}
                      />
                    ))}
                  </details>
                ),
              )}
            </div>
            {message.role === 'assistant' && message.parts.some((part) => part.type === 'text') && (
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
  part: Message['parts'][number]
  sessionId: string
}): ReactNode {
  if (part.type === 'text') return <Markdown text={part.text} />
  if (part.type === 'image')
    return <ImageAttachment sessionId={sessionId} id={part.attachmentId} name={part.name} />
  const thinking = part.type === 'thinking'
  const result = part.type === 'tool-result'
  const label = thinking
    ? 'Reasoning'
    : part.type === 'tool-call'
      ? part.name
      : result && part.isError
        ? 'Tool reported an error'
        : 'Tool result'
  const content = thinking ? part.text : part.type === 'tool-call' ? part.argsJson : part.resultJson
  return (
    <details className="my-2 rounded-xl border border-border bg-surface-1">
      <summary
        className={`flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs ${result && part.isError ? 'text-danger' : 'text-fg-muted'}`}
      >
        {thinking ? <Sparkles size={14} /> : <Terminal size={14} />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight size={13} />
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border p-3 font-mono text-xs leading-relaxed text-fg-muted">
        {toolContent(content)}
      </pre>
    </details>
  )
}
function toolContent(content: string): string {
  try {
    const value: unknown = JSON.parse(content)
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return content
  }
}
function CopyMessage({ text }: { text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      aria-label="Copy assistant message"
      className="mt-1 flex min-h-11 items-center gap-1.5 text-[11px] text-fg-subtle"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setFailed(false)
          })
          .catch(() => setFailed(true))
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {failed ? 'Clipboard unavailable' : copied ? 'Copied' : 'Copy'}
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
