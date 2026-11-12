/** How many bars the effort glyph draws at most. */
const MAX_BARS = 5

/**
 * Where a level sits when its name is one every agent uses. Agents advertise
 * their own vocabulary, so anything not listed here is left unranked.
 */
const KNOWN_RANK: Record<string, number> = {
  off: 0,
  none: 0,
  disabled: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  med: 3,
  standard: 3,
  normal: 3,
  high: 4,
  xhigh: 5,
  'x-high': 5,
  'extra-high': 5,
  extra: 5,
  max: 5,
  maximum: 5,
  ultra: 5,
}

function knownRank(option: { id: string; label: string }): number | undefined {
  for (const name of [option.id, option.label]) {
    const rank =
      KNOWN_RANK[
        name
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, '-')
      ]
    if (rank !== undefined) return rank
  }
  return undefined
}

/**
 * How much effort each option stands for, as `filled` bars out of `bars`.
 * When every option has a familiar name the names decide, so a list an agent
 * sends highest-first still draws the right way up. Otherwise the agent's own
 * order is taken as lowest to highest. Returned in the options' order.
 */
export function effortLevels(
  options: readonly { id: string; label: string }[],
): { filled: number; bars: number }[] {
  if (options.length === 0) return []
  const ranks = options.map(knownRank)
  const named = ranks.filter((rank): rank is number => rank !== undefined)
  const known = named.length === options.length
  // Position among the distinct levels present, lowest first.
  const steps = known ? [...new Set(named)].sort((a, b) => a - b) : []
  const count = known ? steps.length : options.length
  const bars = Math.min(MAX_BARS, Math.max(2, count))
  return options.map((_, index) => {
    const position = known ? steps.indexOf(named[index] ?? 0) : index
    // A lone level fills the glyph; the lowest of several shows one bar.
    const filled = count <= 1 ? bars : 1 + Math.round((position * (bars - 1)) / (count - 1))
    return { filled, bars }
  })
}

/**
 * A small rising bar chart: how hard the model will think at this level.
 * Drawn in the current text colour; the bars beyond the level are faint.
 */
export function EffortGlyph({
  filled,
  bars,
  className,
}: {
  filled: number
  bars: number
  className?: string
}) {
  const width = 15
  const height = 15
  const gap = 1.5
  const barWidth = (width - gap * (bars - 1)) / bars
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-hidden="true"
      data-effort-level={`${String(filled)}/${String(bars)}`}
      className={className}
    >
      {Array.from({ length: bars }, (_, index) => {
        // Shortest bar is a third of the height; the last one is full height.
        const barHeight = height * (1 / 3 + (2 / 3) * (bars === 1 ? 1 : index / (bars - 1)))
        return (
          <rect
            key={index}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={0.75}
            fill="currentColor"
            opacity={index < filled ? 1 : 0.22}
          />
        )
      })}
    </svg>
  )
}
