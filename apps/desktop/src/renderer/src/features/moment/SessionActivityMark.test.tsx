import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SessionActivityMark } from './SessionActivityMark'

describe('SessionActivityMark', () => {
  it('announces working with the nine-cell forging matrix', () => {
    const { container } = render(
      <SessionActivityMark activity={{ phase: 'working', startedAt: Date.now() }} />,
    )
    expect(screen.getByRole('status', { name: 'Working' })).toBeInTheDocument()
    expect(container.querySelectorAll('.ari-forge-cell')).toHaveLength(8)
  })

  it('announces a pause while waiting for the user', () => {
    render(
      <SessionActivityMark
        activity={{ phase: 'paused', startedAt: Date.now(), pauseReason: 'approval' }}
      />,
    )
    expect(screen.getByRole('status', { name: 'Waiting for you' })).toBeInTheDocument()
  })

  it('announces turn complete and turn failed', () => {
    const { rerender } = render(
      <SessionActivityMark activity={{ phase: 'done', startedAt: null, settledAt: Date.now() }} />,
    )
    expect(screen.getByRole('status', { name: 'Turn complete' })).toBeInTheDocument()
    rerender(
      <SessionActivityMark activity={{ phase: 'error', startedAt: null, settledAt: Date.now() }} />,
    )
    expect(screen.getByRole('status', { name: 'Turn failed' })).toBeInTheDocument()
  })
})
