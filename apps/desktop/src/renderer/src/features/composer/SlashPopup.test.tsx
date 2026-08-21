import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SlashPopup } from './SlashPopup'

describe('SlashPopup', () => {
  it('renders the filtered commands for the query', () => {
    render(<SlashPopup query="/mo" onSelect={vi.fn()} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toMatchObject([
      expect.stringContaining('/model'),
      expect.stringContaining('/mode'),
    ])
  })

  it('renders nothing when nothing matches', () => {
    const { container } = render(<SlashPopup query="/zzz" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('moves the highlight with ArrowDown/ArrowUp and selects with Enter', () => {
    const onSelect = vi.fn()
    render(<SlashPopup query="/mo" onSelect={onSelect} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'model' }))
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<SlashPopup query="/mo" onSelect={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('selects on click', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<SlashPopup query="/mo" onSelect={onSelect} onClose={vi.fn()} />)
    await user.click(screen.getAllByRole('option')[1]!)
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'mode' }))
  })
})
