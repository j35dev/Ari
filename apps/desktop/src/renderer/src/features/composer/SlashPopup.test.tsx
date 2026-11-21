import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SlashCommand } from '@ari/contracts/slash-commands'
import { SlashPopup } from './SlashPopup'

const ITEMS: SlashCommand[] = [
  {
    name: 'compact',
    description: 'Free up context',
    argumentHint: '<instructions>',
    source: 'builtin',
    run: 'prompt-text',
  },
  {
    name: 'model',
    description: 'Set the model',
    argumentHint: null,
    source: 'builtin',
    run: 'unsupported',
    reason: "Choose the model with Ari's model picker under the message box.",
  },
  {
    name: 'deploy',
    description: 'Ship it',
    argumentHint: null,
    source: 'project',
    run: 'prompt-text',
  },
]

describe('SlashPopup', () => {
  it('shows each command with its hint, description and source', () => {
    render(<SlashPopup items={ITEMS} onSelect={vi.fn()} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveTextContent('/compact<instructions>Free up contextBuilt-in')
    expect(options[1]).toHaveAttribute('aria-disabled', 'true')
    expect(options[2]).toHaveTextContent('Project')
  })

  it('moves with the arrows and picks with Enter or Tab', () => {
    const onSelect = vi.fn()
    render(<SlashPopup items={ITEMS} onSelect={onSelect} onClose={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[2])
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[0])
  })

  it('never picks a disabled command, and says why it is disabled', () => {
    const onSelect = vi.fn()
    render(<SlashPopup items={ITEMS} onSelect={onSelect} onClose={vi.fn()} />)
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getByRole('status')).toHaveTextContent("Ari's model picker")
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    window.dispatchEvent(enter)
    // Swallowed: Enter on a disabled row must not fall through and send the draft.
    expect(enter.defaultPrevented).toBe(true)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape and selects on click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSelect = vi.fn()
    render(<SlashPopup items={ITEMS} onSelect={onSelect} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    await user.click(screen.getAllByRole('option')[1]!)
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getAllByRole('option')[2]!)
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2])
  })

  it('stays inside the composer’s width and scrolls past a capped height', () => {
    render(<SlashPopup items={ITEMS} onSelect={vi.fn()} onClose={vi.fn()} note="Loading…" />)
    expect(screen.getByRole('listbox').className).toMatch(/max-h-\[264px\].*overflow-y-auto/)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
