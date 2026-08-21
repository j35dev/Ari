import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Badge } from './Badge'

afterEach(cleanup)

describe('Badge', () => {
  it('maps tones to subtle bg + readable fg token pairs', () => {
    render(
      <>
        <Badge>neutral</Badge>
        <Badge tone="accent">accent</Badge>
        <Badge tone="success">success</Badge>
        <Badge tone="warning">warning</Badge>
        <Badge tone="danger">danger</Badge>
      </>,
    )
    expect(screen.getByText('neutral')).toHaveClass('bg-surface-2', 'text-fg-muted')
    expect(screen.getByText('accent')).toHaveClass('bg-accent-subtle', 'text-fg')
    expect(screen.getByText('success')).toHaveClass('bg-success-subtle', 'text-success')
    expect(screen.getByText('warning')).toHaveClass('bg-warning-subtle', 'text-warning')
    expect(screen.getByText('danger')).toHaveClass('bg-danger-subtle', 'text-danger')
  })

  it('applies size variants and base styling', () => {
    render(
      <>
        <Badge size="sm">sm</Badge>
        <Badge size="md">md</Badge>
      </>,
    )
    expect(screen.getByText('sm')).toHaveClass('px-1', 'py-px', 'uppercase', 'tracking-wide', 'text-2xs')
    expect(screen.getByText('md')).toHaveClass('px-1.5', 'py-0.5')
  })
})
