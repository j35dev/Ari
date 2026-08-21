import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ScrollArea } from './ScrollArea'

afterEach(cleanup)

describe('ScrollArea', () => {
  it('renders children inside a native-scroll container tagged ari-scroll', () => {
    render(
      <ScrollArea data-testid="area">
        <p>content</p>
      </ScrollArea>,
    )
    const area = screen.getByTestId('area')
    expect(area).toHaveClass('ari-scroll', 'overflow-auto')
    expect(screen.getByText('content')).toBeInTheDocument()
  })
})
