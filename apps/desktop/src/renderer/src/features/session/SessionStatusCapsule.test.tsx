import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ContextMeter,
  SessionStatusCapsule,
  contextTone,
  formatCompactTokens,
  formatTurnDuration,
  type SessionStatusCapsuleProps,
} from './SessionStatusCapsule'

const TYPICAL: SessionStatusCapsuleProps = {
  turnCount: 3,
  lastDurationMs: 718_000,
  inputTokens: 37_900,
  cachedInputTokens: 21_000,
  outputTokens: 12_400,
  context: { usedTokens: 37_900, windowTokens: 200_000 },
  contextWindow: 200_000,
  hidden: false,
}

function renderCapsule(overrides: Partial<SessionStatusCapsuleProps> = {}) {
  return render(<SessionStatusCapsule {...TYPICAL} {...overrides} />)
}

describe('SessionStatusCapsule', () => {
  it('reads turn count, last latency, session tokens and context headroom', () => {
    renderCapsule()

    expect(screen.getByText('3 turns')).toBeInTheDocument()
    expect(screen.getByTitle('Last turn took 11m 58s')).toBeInTheDocument()
    expect(
      screen.getByTitle('Input tokens this session: 37,900 (21,000 read from cache)'),
    ).toHaveTextContent('↑ 37.9K')
    expect(screen.getByTitle('Output tokens this session: 12,400')).toHaveTextContent('↓ 12.4K')
    expect(screen.getByText('37.9K / 200K')).toBeInTheDocument()
  })

  it('names one turn in the singular', () => {
    renderCapsule({ turnCount: 1, lastDurationMs: null })
    expect(screen.getByText('1 turn')).toBeInTheDocument()
  })

  it('keeps its slot before the first reading, out of the tab order and the a11y tree', () => {
    const { container } = renderCapsule({
      turnCount: 0,
      lastDurationMs: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      context: null,
      contextWindow: null,
    })
    // The band stays in the document so the composer below it never moves; it
    // is faded out and hidden from assistive tech until it has something to say.
    const band = container.firstElementChild as HTMLElement
    expect(band).toHaveAttribute('aria-hidden', 'true')
    expect(band.className).toContain('opacity-0')
    expect(container.querySelector('.ari-status-capsule')).not.toBeNull()
  })

  it('hides itself on the welcome canvas that has no conversation yet', () => {
    const { container } = renderCapsule({ hidden: true })
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('leaves token totals out when the agent reports only a context reading', () => {
    renderCapsule({
      turnCount: 0,
      lastDurationMs: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      context: { usedTokens: 33_587, windowTokens: 200_000 },
    })
    expect(screen.getByText('33.6K / 200K')).toBeInTheDocument()
    expect(screen.queryByText(/↑|↓/)).not.toBeInTheDocument()
  })

  it('shows no meter until a context reading arrives', () => {
    renderCapsule({ context: null, contextWindow: null })
    expect(screen.queryByLabelText(/Context used/)).not.toBeInTheDocument()
  })

  it('omits the denominator when no window is known', () => {
    renderCapsule({ context: { usedTokens: 33_587, windowTokens: null }, contextWindow: null })
    expect(screen.getByTitle('Context: 33.6K tokens')).toBeInTheDocument()
  })
})

describe('context meter tone', () => {
  it('turns amber at 75% and red at 90% of the window', () => {
    expect(contextTone(74)).toBe('accent')
    expect(contextTone(75)).toBe('warning')
    expect(contextTone(89)).toBe('warning')
    expect(contextTone(90)).toBe('danger')
    expect(contextTone(100)).toBe('danger')
    expect(contextTone(null)).toBe('accent')
  })

  it('fills by proportion and clamps an over-full window', () => {
    const { container } = render(<ContextMeter used={50_000} contextWindow={200_000} />)
    expect(container.querySelector<HTMLElement>('.ari-status-capsule-fill')?.style.transform).toBe(
      'scaleX(0.25)',
    )
    const { container: over } = render(<ContextMeter used={400_000} contextWindow={200_000} />)
    expect(over.querySelector<HTMLElement>('.ari-status-capsule-fill')?.style.transform).toBe(
      'scaleX(1)',
    )
  })

  it('draws no bar without a window to fill', () => {
    const { container } = render(<ContextMeter used={42} contextWindow={null} />)
    expect(container.querySelector('.ari-status-capsule-fill')).toBeNull()
    expect(container.textContent).toBe('context42')
  })
})

describe('status formatting', () => {
  it('formats compact token counts', () => {
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(12_500)).toBe('12.5K')
    expect(formatCompactTokens(200_000)).toBe('200K')
    expect(formatCompactTokens(999_960)).toBe('1M')
    expect(formatCompactTokens(3_412_900)).toBe('3.4M')
  })

  it('formats turn latency in seconds, then minutes', () => {
    expect(formatTurnDuration(52_800)).toBe('52.8s')
    expect(formatTurnDuration(59_700)).toBe('1m 00s')
    expect(formatTurnDuration(125_400)).toBe('2m 05s')
  })
})
