import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Skeleton } from './Skeleton'

afterEach(cleanup)

describe('Skeleton', () => {
  it('is hidden from assistive technology', () => {
    render(<Skeleton data-testid="skeleton" />)
    expect(screen.getByTestId('skeleton')).toHaveAttribute('aria-hidden', 'true')
  })

  it('applies pulse styling and honors w/h dimensions', () => {
    render(<Skeleton data-testid="skeleton" w={120} h="2rem" />)
    const el = screen.getByTestId('skeleton')
    expect(el).toHaveClass('ari-pulse', 'bg-surface-2', 'rounded-md')
    expect(el).toHaveStyle({ width: '120px', height: '32px' })
  })
})
