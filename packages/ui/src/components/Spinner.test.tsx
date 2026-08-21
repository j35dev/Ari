import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Spinner } from './Spinner'

afterEach(cleanup)

describe('Spinner', () => {
  it('exposes loading status to assistive technology', () => {
    render(<Spinner />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading')
  })

  it('maps sizes to utilities and inherits text color via border-current', () => {
    render(<Spinner size="lg" data-testid="spinner" />)
    expect(screen.getByTestId('spinner')).toHaveClass(
      'size-7',
      'border-current',
      'border-t-transparent',
      'motion-safe:animate-spin',
    )
  })
})
