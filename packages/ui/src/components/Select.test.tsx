import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'
import type { SelectOption } from './Select'

const options: SelectOption[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'grok', label: 'Grok', disabled: true },
  { value: 'pi', label: 'Pi' },
]

function Harness({
  onValueChange,
  value: controlled,
}: {
  onValueChange?: (value: string) => void
  value?: string
}) {
  const [value, setValue] = useState(controlled ?? '')
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        onValueChange?.(next)
        setValue(next)
      }}
      options={options}
      placeholder="Choose agent"
    />
  )
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button'))
  return screen.getByRole('listbox')
}

describe('Select', () => {
  it('opens on trigger click and renders the options', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('Choose agent')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    await user.click(trigger)

    expect(screen.getByRole('listbox')).toBeInTheDocument()
    for (const label of ['Claude', 'Codex', 'Grok', 'Pi']) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument()
    }
  })

  it('selects on click, updates the trigger label, and closes', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)
    const trigger = screen.getByRole('button')
    await open(user)

    await user.click(screen.getByRole('option', { name: 'Codex' }))

    expect(onValueChange).toHaveBeenCalledWith('codex')
    expect(trigger).toHaveTextContent('Codex')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('navigates with arrow keys and selects with Enter', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)
    const listbox = await open(user)

    // Opening highlights the first enabled option.
    expect(screen.getByRole('option', { name: 'Claude' })).toHaveAttribute('data-active')

    // Skips the disabled Grok option.
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Codex' })).toHaveAttribute('data-active')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Pi' })).toHaveAttribute('data-active')
    expect(listbox).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Pi' }).id,
    )

    await user.keyboard('{Enter}')

    expect(onValueChange).toHaveBeenCalledWith('pi')
    expect(screen.getByRole('button')).toHaveTextContent('Pi')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('closes on Escape without changing the selection', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)
    await open(user)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    expect(onValueChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button')).toHaveFocus()
  })

  it('reflects selection state via aria-selected and the check mark', async () => {
    const user = userEvent.setup()
    render(<Harness value="codex" />)
    await open(user)

    const codex = screen.getByRole('option', { name: 'Codex' })
    expect(codex).toHaveAttribute('aria-selected', 'true')
    expect(codex.querySelector('svg')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'Claude' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(screen.getByRole('button')).toHaveTextContent('Codex')
  })

  it('jumps with Home/End and typeaheads by first letter', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)
    await open(user)

    await user.keyboard('{End}')
    expect(screen.getByRole('option', { name: 'Pi' })).toHaveAttribute('data-active')
    await user.keyboard('{Home}')
    expect(screen.getByRole('option', { name: 'Claude' })).toHaveAttribute('data-active')

    await user.keyboard('p')
    expect(screen.getByRole('option', { name: 'Pi' })).toHaveAttribute('data-active')
    await user.keyboard('{Enter}')
    expect(onValueChange).toHaveBeenCalledWith('pi')
  })

  it('ignores clicks on disabled options', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    render(<Harness onValueChange={onValueChange} />)
    await open(user)

    await user.click(screen.getByRole('option', { name: 'Grok' }))

    expect(onValueChange).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})
