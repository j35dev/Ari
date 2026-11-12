import { ReadAloud } from '../aria/ReadAloud'
import { writtenReply } from '@ari/contracts/aria-voice'
import { CopyButton } from './CopyButton'
import type { Message } from '@ari/contracts/message'
import { RefreshCw, TextQuote } from 'lucide-react'
import { iconButton } from '../../lib/recipes'

/** Usage figures for one assistant message, as extracted by the engine (M4.18). */
export interface MessageUsage {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

/** `1234` → `'1.2k'`, `340` → `'340'`; one decimal below 100k, rounded above. */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  const s = k < 100 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))
  return `${s}k`
}

/** `0.004` → `'.004'`, `1.25` → `'1.25'` — no leading zero on sub-dollar costs. */
function formatCost(usd: number): string {
  if (usd >= 1) return usd.toFixed(2)
  return usd.toFixed(3).replace(/^0/, '')
}

/** Concatenated text parts of a message — what "copy message" should put on the clipboard. */
function messageText(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** Blockquote the reply, one `> ` prefix per line, without trailing whitespace. */
function quoteOf(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
    .replace(/\s+$/, '')
}

/**
 * The quiet row a reply ends on: local timestamp, optional token/cost usage,
 * then ghost icon actions — copy for the message's text content, quote, and a
 * regenerate control on the newest assistant message (M19.4) that re-runs the
 * last user prompt. Regenerate is disabled while `actionDisabled` is set
 * (a turn is running).
 *
 * The newest reply shows its actions outright. Earlier ones keep the row's
 * height but reveal the actions on hover or keyboard focus of the reply (the
 * `group/turn` wrapper in TranscriptView), so history stays mostly prose.
 */
export function MessageFooter({
  message,
  usage,
  onRegenerate,
  onQuote,
  quoteText,
  actionDisabled = false,
  readAloud = false,
}: {
  message: Message
  readAloud?: boolean
  usage?: MessageUsage
  /** Present on the newest assistant message: offers regenerating the last turn. */
  onRegenerate?: () => void
  /** Quotes `quoteText` into the composer. Copy stays on this footer's own text. */
  onQuote?: (quoted: string) => void
  /** Full assistant reply. Omitted hides the quote button. */
  quoteText?: string
  /** Disables action buttons — true while a turn runs or no prompt exists. */
  actionDisabled?: boolean
}) {
  const text = writtenReply(messageText(message))
  const quotable = quoteText?.trim() ?? ''
  const newest = onRegenerate !== undefined
  return (
    <div className="mt-2 flex h-7 items-center gap-2 text-[13px] text-fg-subtle">
      <span className="tabular-nums">
        {new Date(message.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
      {usage ? (
        <span className="font-mono text-xs tabular-nums">
          ↑{formatTokenCount(usage.inputTokens)} ↓{formatTokenCount(usage.outputTokens)} ·{' '}
          {formatCost(usage.costUsd)}
        </span>
      ) : null}
      <span
        className={`flex items-center ${
          newest
            ? ''
            : 'opacity-0 transition-opacity focus-within:opacity-100 group-hover/turn:opacity-100'
        }`}
      >
        {readAloud && message.sessionId && message.role === 'assistant' ? (
          <ReadAloud sessionId={message.sessionId} messageId={message.id} />
        ) : null}
        {text ? <CopyButton text={text} /> : null}
        {onQuote && quotable.length > 0 ? (
          <button
            type="button"
            onClick={() => onQuote(quoteOf(quoteText ?? ''))}
            aria-label="Quote reply"
            title="Quote reply"
            className={iconButton}
          >
            <TextQuote size={14} />
          </button>
        ) : null}
        {onRegenerate ? (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={actionDisabled}
            aria-label="Regenerate response"
            title="Regenerate response"
            className={iconButton}
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </span>
    </div>
  )
}
