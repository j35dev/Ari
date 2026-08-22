import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FilePopup } from './FilePopup'

const ITEMS = ['src/app.ts', 'src/main.tsx', 'docs/arch.md']

describe('FilePopup', () => {
  it('renders the given paths', () => {
    render(<FilePopup items={ITEMS} onSelect={vi.fn()} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toMatchObject([
      expect.stringContaining('src/app.ts'),
      expect.stringContaining('src/main.tsx'),
      expect.stringContaining('docs/arch.md'),
    ])
  })

  it('renders nothing when there are no items', () => {
    const { container } = render(<FilePopup items={[]} onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('moves the highlight with ArrowDown/ArrowUp and selects with Enter', () => {
    const onSelect = vi.fn()
    render(<FilePopup items={ITEMS} onSelect={onSelect} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('src/main.tsx')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<FilePopup items={ITEMS} onSelect={vi.fn()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('selects on click', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<FilePopup items={ITEMS} onSelect={onSelect} onClose={vi.fn()} />)
    await user.click(screen.getAllByRole('option')[2]!)
    expect(onSelect).toHaveBeenCalledWith('docs/arch.md')
  })
})
