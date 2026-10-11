import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnErrorBanner } from './TurnErrorBanner'

afterEach(cleanup)

const AUTH_ERROR =
  'AuthError: claude is not authenticated yet — run its login flow once in a terminal, then retry'

describe('TurnErrorBanner resume', () => {
  const banner = (resume: Parameters<typeof TurnErrorBanner>[0]['resume']) => (
    <TurnErrorBanner
      message="usage limit reached"
      canRetry
      retryDisabled={false}
      onRetry={() => {}}
      onDismiss={() => {}}
      resume={resume}
    />
  )
  const controls = { format: () => '3:42 PM', onSchedule: vi.fn(), onCancel: vi.fn() }

  it('offers to resume at the reset time, then shows the schedule with a way out', async () => {
    const user = userEvent.setup()
    const { rerender } = render(banner({ ...controls, resetAt: 5, scheduledAt: null }))
    await user.click(screen.getByRole('button', { name: 'Resume at 3:42 PM' }))
    expect(controls.onSchedule).toHaveBeenCalledOnce()

    rerender(banner({ ...controls, resetAt: 5, scheduledAt: 5 }))
    expect(screen.getByText('Ari will continue this session at 3:42 PM.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Resume at/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(controls.onCancel).toHaveBeenCalledOnce()
  })

  it('offers nothing when the provider does not say when the limit resets', () => {
    render(banner({ ...controls, resetAt: null, scheduledAt: null }))
    expect(screen.queryByRole('button', { name: /Resume at/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry last message' })).toBeInTheDocument()
  })
})

describe('TurnErrorBanner', () => {
  it('shows the classified headline, friendly message, and hint', () => {
    render(
      <TurnErrorBanner
        message={AUTH_ERROR}
        canRetry
        retryDisabled={false}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )

    expect(screen.getByText(/Authentication required/)).toBeInTheDocument()
    expect(screen.getByText(/claude is not authenticated yet/)).toBeInTheDocument()
    expect(
      screen.getByText('Run the agent’s login flow once in a terminal, then retry.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry last message' })).toBeInTheDocument()
  })

  it('keeps the raw error behind the details disclosure', async () => {
    const user = userEvent.setup()
    render(
      <TurnErrorBanner
        message={AUTH_ERROR}
        canRetry={false}
        retryDisabled={false}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )

    // Raw text is hidden until asked; the leaked class prefix stays verbatim.
    expect(screen.queryByText(/AuthError: claude/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Toggle error details' }))
    expect(screen.getByText(/AuthError: claude/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument()
  })

  it('does not repeat the headline when no family is recognised', () => {
    render(
      <TurnErrorBanner
        message="model returned an empty response (3 attempts)"
        canRetry={false}
        retryDisabled={false}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )

    expect(screen.getByText('Turn failed —')).toBeInTheDocument()
    expect(screen.queryByText(/Turn failed — Turn failed/)).not.toBeInTheDocument()
    expect(screen.getByText(/empty response \(3 attempts\)/)).toBeInTheDocument()
  })

  it('wires retry and dismiss', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    render(
      <TurnErrorBanner
        message="boom"
        canRetry
        retryDisabled={false}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Retry last message' }))
    await user.click(screen.getByRole('button', { name: 'Dismiss error' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
