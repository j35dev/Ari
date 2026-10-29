import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { insertMention, memberCharacter, type RoomMember } from './team-room'

export interface RoomComposerProps {
  members: readonly RoomMember[]
  /** Resolves once the host has taken the message; a rejection is shown under the field. */
  onSend: (text: string) => Promise<void>
}

/**
 * The room's message field. Enter sends and Shift+Enter breaks the line, as
 * in a session; the chips below address a bot by inserting its mention.
 */
export function RoomComposer({ members, onSend }: RoomComposerProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const caretRef = useRef<number | null>(null)

  // Lands the caret after an inserted mention once the new draft is painted.
  useLayoutEffect(() => {
    const field = fieldRef.current
    const caret = caretRef.current
    if (field === null || caret === null) return
    caretRef.current = null
    field.focus()
    field.setSelectionRange(caret, caret)
  }, [text])

  // The field is disabled while a send is in flight, which drops its focus;
  // it takes it back once it can be typed into again.
  useEffect(() => {
    if (!sending) fieldRef.current?.focus()
  }, [sending])

  const canSend = text.trim().length > 0 && !sending

  const send = async (): Promise<void> => {
    const message = text.trim()
    if (message.length === 0 || sending) return
    setSending(true)
    setError(null)
    try {
      await onSend(message)
      setText('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSending(false)
    }
  }

  const mention = (name: string): void => {
    const field = fieldRef.current
    const selection = {
      start: field?.selectionStart ?? text.length,
      end: field?.selectionEnd ?? text.length,
    }
    const next = insertMention(text, selection, name)
    caretRef.current = next.caret
    setText(next.text)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="ari-composer-shell relative rounded-2xl">
        <textarea
          ref={fieldRef}
          value={text}
          rows={1}
          disabled={sending}
          aria-label="Message the room"
          placeholder="Message the room — @mention a bot to address it"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          className="block max-h-[200px] min-h-12 w-full resize-none bg-transparent py-3.5 pr-12 pl-4 text-sm leading-relaxed text-fg field-sizing-content placeholder:text-fg-subtle/70 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          aria-label="Send"
          title="Send"
          disabled={!canSend}
          onClick={() => void send()}
          className={`absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-xl shadow-sm transition-[color,background-color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
            canSend
              ? 'bg-accent text-fg-on-accent hover:bg-accent-hover'
              : 'bg-surface-3/50 text-fg-subtle opacity-60'
          }`}
        >
          <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>

      <div
        role="group"
        aria-label="Mention a bot"
        className="flex flex-wrap items-center gap-1 px-1"
      >
        {members.map((member) => (
          <button
            key={member.botId}
            type="button"
            disabled={sending}
            aria-label={`Mention ${member.name}`}
            onClick={() => mention(member.name)}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface-1 px-1.5 text-2xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50"
          >
            <BotAvatar character={memberCharacter(member)} size={14} />@{member.name}
          </button>
        ))}
      </div>

      {error !== null ? (
        <p role="alert" className="px-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
