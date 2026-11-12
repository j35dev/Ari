import type { CSSProperties, ReactNode } from 'react'
import { formatElapsed } from '../moment'

/**
 * Turn latency for the meta line: 52.8s, then 2m 05s once it passes a minute.
 * Sub-minute keeps the decimal because a fast turn's difference lives there.
 */
export function formatTurnDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(seconds)
}

/** Compact token formatting for the meter: 200K, 1M, 12.5K, 999. */
export function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n)
  // Rounded first, so 3,982 reads 4K and 999,960 reads 1M, never 4.0K or 1000K.
  const k = Number((n / 1000).toFixed(1))
  return k < 1000 ? `${k}K` : `${Number((n / 1_000_000).toFixed(1))}M`
}

const METER_WARN_PCT = 75
const METER_DANGER_PCT = 90

/** The meter's tone is the one functional colour in the line: it means "act". */
export function contextTone(pct: number | null): 'accent' | 'warning' | 'danger' {
  if (pct !== null && pct >= METER_DANGER_PCT) return 'danger'
  if (pct !== null && pct >= METER_WARN_PCT) return 'warning'
  return 'accent'
}

/**
 * Context-window meter: a small ring and the share of the window in use. The
 * token counts behind the percentage stay in the tooltip and the accessible
 * name. Without a known window only the used count shows — the denominator is
 * the provider's own reading, else the session model's catalog hint, and
 * inventing one would make the ring lie about headroom.
 */
export function ContextMeter({
  used,
  contextWindow,
}: {
  used: number
  contextWindow: number | null
}) {
  const pct =
    contextWindow !== null && contextWindow > 0
      ? Math.min(100, Math.round((used / contextWindow) * 100))
      : null
  const tone = contextTone(pct)
  return (
    <span
      className="flex items-center gap-1.5"
      title={
        contextWindow !== null
          ? `Context: ${formatCompactTokens(used)} of ${formatCompactTokens(contextWindow)} tokens (${pct}%)`
          : `Context: ${formatCompactTokens(used)} tokens`
      }
    >
      {pct !== null ? (
        // A custom property, not a width: a fresh reading retargets the ring
        // without laying the line out again (see session-canvas.css).
        <span
          aria-hidden="true"
          className="ari-status-capsule-fill"
          data-tone={tone === 'accent' ? undefined : tone}
          style={{ '--ari-context-fill': pct } as CSSProperties}
        />
      ) : null}
      <span
        aria-label={`Context used: ${formatCompactTokens(used)}${contextWindow !== null ? ` of ${formatCompactTokens(contextWindow)}` : ''}`}
      >
        {pct !== null ? `${pct}% context` : `${formatCompactTokens(used)} context`}
      </span>
    </span>
  )
}

function Divider() {
  return <span aria-hidden="true" className="ari-status-divider h-3 w-px shrink-0 bg-border" />
}

export interface SessionStatusCapsuleProps {
  /** Turns begun in this session, including the live one. */
  turnCount: number
  /** How long the last settled turn took; null until one settles. */
  lastDurationMs: number | null
  /** Session totals, summed over every `usage.recorded`. */
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  /** The provider's latest context reading; null until it sends one. */
  context: { usedTokens: number; windowTokens: number | null } | null
  /** Provider window, else the session model's catalog hint. */
  contextWindow: number | null
  /** Blank welcome canvas: the line belongs to a conversation, not the intro. */
  hidden: boolean
}

/**
 * The session's vital signs as one quiet line under the composer: how many
 * turns, how long the last one took, what the session has spent, and at the
 * right how much of the context window is in use.
 *
 * Every figure is a cumulative total or a latest-reading snapshot — never a
 * live stopwatch. A running turn's elapsed time belongs to the transcript's
 * working glyph, beside the work it measures; a second timer here would tick
 * against it.
 *
 * Shows nothing before the first turn and the first context reading. Its slot
 * is kept rather than unmounted, so the line holds its height — the first turn
 * of a session fades into place instead of shoving the composer up. It is
 * display-only, so it never enters the tab order, and it carries no live
 * region — streamed readings would otherwise be announced as they arrive.
 */
export function SessionStatusCapsule({
  turnCount,
  lastDurationMs,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  context,
  contextWindow,
  hidden,
}: SessionStatusCapsuleProps) {
  const spent = inputTokens + outputTokens
  const blank = hidden || (turnCount === 0 && context === null)

  const segments: ReactNode[] = []
  if (turnCount > 0) {
    segments.push(
      <span key="turns" className="ari-status-capsule-turns flex shrink-0 items-center gap-3">
        <span>
          {turnCount} turn{turnCount === 1 ? '' : 's'}
        </span>
        {lastDurationMs !== null ? (
          <span
            className="ari-status-capsule-duration"
            title={`Last turn took ${formatTurnDuration(lastDurationMs)}`}
          >
            {formatTurnDuration(lastDurationMs)}
          </span>
        ) : null}
      </span>,
    )
  }
  // Some agents report a context reading but no token totals.
  if (spent > 0) {
    segments.push(
      <span key="tokens" className="ari-status-capsule-tokens flex shrink-0 items-center gap-3">
        <span
          title={`Input tokens this session: ${inputTokens.toLocaleString('en-US')}${
            cachedInputTokens > 0
              ? ` (${cachedInputTokens.toLocaleString('en-US')} read from cache)`
              : ''
          }`}
        >
          ↑ {formatCompactTokens(inputTokens)}
        </span>
        <span title={`Output tokens this session: ${outputTokens.toLocaleString('en-US')}`}>
          ↓ {formatCompactTokens(outputTokens)}
        </span>
      </span>,
    )
  }

  const body: ReactNode[] = []
  for (const [i, segment] of segments.entries()) {
    if (i > 0) body.push(<Divider key={`divider-${i}`} />)
    body.push(segment)
  }

  return (
    <div
      className={`ari-chat-column shrink-0 pb-3 pt-2 transition-opacity duration-[var(--ari-dur-panel)] ${blank ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
      aria-hidden={blank || undefined}
    >
      <div className="ari-status-capsule flex min-h-5 items-center gap-3 whitespace-nowrap px-3 text-[12.5px] tabular-nums text-fg-subtle">
        {body}
        {/* Headroom comes from the provider's own reading of the window. Summing
            the turns' tokens instead would count each re-read of the
            conversation again and miss everything served from cache. */}
        {context !== null ? (
          <span className="ms-auto flex shrink-0">
            <ContextMeter used={context.usedTokens} contextWindow={contextWindow} />
          </span>
        ) : null}
      </div>
    </div>
  )
}
