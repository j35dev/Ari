import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import type { PaletteCommand } from './useCommands'

function makeCommands(): PaletteCommand[] {
  return [
    { id: 'sessions', label: 'Go to Sessions', run: vi.fn() },
    { id: 'settings', label: 'Go to Settings', hint: 'G S', run: vi.fn() },
    { id: 'gallery', label: 'Browse component gallery', run: vi.fn() },
  ]
}

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <CommandPalette open={false} onClose={vi.fn()} commands={makeCommands()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists every command for an empty query and marks the first active', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Go to Settings')).toBeInTheDocument()
  })

  it('renders the kbd hint chip on items that declare one', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)
    expect(screen.getByText('G S').tagName).toBe('KBD')
  })

  it('filters the list as the user types', async () => {
    const user = userEvent.setup()
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)
    await user.type(screen.getByLabelText('Search commands'), 'sett')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Go to Settings')).toBeInTheDocument()
  })

  it('shows an empty state when nothing matches', async () => {
    const user = userEvent.setup()
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)
    await user.type(screen.getByLabelText('Search commands'), 'zzz')
    expect(screen.getByText('No matching commands')).toBeInTheDocument()
  })

  it('cycles the highlight with ArrowDown/ArrowUp and runs with Enter', () => {
    const commands = makeCommands()
    render(<CommandPalette open onClose={vi.fn()} commands={commands} />)

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(commands[0]!.run).toHaveBeenCalledOnce()
  })

  it('closes after running a command', () => {
    const onClose = vi.fn()
    const commands = makeCommands()
    render(<CommandPalette open onClose={onClose} commands={commands} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(commands[0]!.run).toHaveBeenCalledOnce()
  })

  it('wraps the highlight at both ends of the list', () => {
    render(<CommandPalette open onClose={vi.fn()} commands={makeCommands()} />)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<CommandPalette open onClose={onClose} commands={makeCommands()} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('runs a command on click without treating it as a backdrop click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const commands = makeCommands()
    render(<CommandPalette open onClose={onClose} commands={commands} />)
    await user.click(screen.getByText('Browse component gallery'))
    expect(commands[2]!.run).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(
      <CommandPalette open onClose={onClose} commands={makeCommands()} />,
    )
    fireEvent.click(container.firstElementChild!)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
