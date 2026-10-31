import { CopyButton } from './CopyButton'
import type { Message } from '@ari/contracts/message'
import { RefreshCw, TextQuote } from 'lucide-react'

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
 * Metadata row rendered under a message: local timestamp, optional token/cost
 * usage line, and affordances — copy for the message's text content, plus a
 * regenerate control on the newest assistant message (M19.4) that re-runs the
 * last user prompt. Regenerate is disabled while `actionDisabled` is set
 * (a turn is running).
 */
export function MessageFooter({
  message,
  usage,
  onRegenerate,
  onQuote,
  quoteText,
  actionDisabled = false,
}: {
  message: Message
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
  const text = messageText(message)
  const quotable = quoteText?.trim() ?? ''
  return (
    <div className="mt-1 flex items-center gap-2 text-2xs text-fg-subtle">
      <span>
        {new Date(message.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
      {usage ? (
        <span className="font-mono tabular-nums">
          ↑{formatTokenCount(usage.inputTokens)} ↓{formatTokenCount(usage.outputTokens)} ·{' '}
          {formatCost(usage.costUsd)}
        </span>
      ) : null}
      {text ? <CopyButton text={text} /> : null}
      {onQuote && quotable.length > 0 ? (
        <button
          type="button"
          onClick={() => onQuote(quoteOf(quoteText ?? ''))}
          aria-label="Quote reply"
          title="Quote reply"
          className="inline-flex items-center rounded-sm p-1 text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <TextQuote size={12} />
        </button>
      ) : null}
      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={actionDisabled}
          aria-label="Regenerate response"
          title="Regenerate response"
          className="inline-flex items-center rounded-sm p-1 text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw size={12} />
        </button>
      ) : null}
    </div>
  )
}
