import { CopyButton } from './CopyButton'
import type { Message } from '@ari/contracts/message'

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

/**
 * Metadata row rendered under a message: local timestamp, optional token/cost
 * usage line, and a copy affordance for the message's text content.
 */
export function MessageFooter({ message, usage }: { message: Message; usage?: MessageUsage }) {
  const text = messageText(message)
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
    </div>
  )
}
