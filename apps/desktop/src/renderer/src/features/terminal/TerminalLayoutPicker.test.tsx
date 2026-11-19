import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TerminalLayoutPicker } from './TerminalLayoutPicker'
import type { TerminalDeskPreset } from './terminal-workspace-state'

function Harness({ changed }: { changed: (value: TerminalDeskPreset) => void }) {
  const [value, setValue] = useState<TerminalDeskPreset>('agents')
  return (
    <TerminalLayoutPicker
      value={value}
      onChange={(value) => {
        setValue(value)
        changed(value)
      }}
    />
  )
}

describe('TerminalLayoutPicker', () => {
  it('shows descriptive layouts and the selected layout in a themed menu', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    await user.click(screen.getByRole('button', { name: 'Terminal desk layout' }))
    expect(screen.getByRole('menu', { name: 'Workspace layouts' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Agent desk/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.click(screen.getByRole('menuitemradio', { name: /Terminal desk/ }))
    expect(changed).toHaveBeenCalledWith('desk')
    expect(screen.getByRole('button', { name: 'Terminal desk layout' })).toHaveTextContent(
      'Terminal desk',
    )
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })

  it('supports arrow navigation, Enter selection and Escape focus restoration', async () => {
    const user = userEvent.setup()
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    const trigger = screen.getByRole('button', { name: 'Terminal desk layout' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(screen.getByRole('menuitemradio', { name: /Agent desk/ })).toHaveFocus(),
    )
    await user.keyboard('{ArrowDown}{Enter}')
    expect(changed).toHaveBeenCalledWith('workbench')
    await user.click(trigger)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
