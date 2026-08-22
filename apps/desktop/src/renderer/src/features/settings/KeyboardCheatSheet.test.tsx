import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { KeyboardCheatSheet } from './KeyboardCheatSheet'

describe('KeyboardCheatSheet', () => {
  it('opens on a bare ? keypress and lists shortcuts in a two-column table', async () => {
    const user = userEvent.setup()
    render(<KeyboardCheatSheet />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.keyboard('?')

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('columnheader', { name: 'Action' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Keys' })).toBeInTheDocument()
    expect(screen.getByText('Toggle command palette')).toBeInTheDocument()
    expect(screen.getByText('Answer an approval card')).toBeInTheDocument()
    expect(screen.getByText('Pick a question option')).toBeInTheDocument()
  })

  it('resolves Mod chords for the current platform', async () => {
    Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true })
    try {
      const user = userEvent.setup()
      render(<KeyboardCheatSheet />)
      await user.keyboard('?')

      const row = screen.getByText('Toggle command palette').closest('tr')
      expect(row).toHaveTextContent('Ctrl')
    } finally {
      Reflect.deleteProperty(window.navigator, 'platform')
    }
  })

  it('ignores ? typed while an input has focus', async () => {
    const user = userEvent.setup()
    render(
      <>
        <input aria-label="composer" />
        <KeyboardCheatSheet />
      </>,
    )

    await user.type(screen.getByLabelText('composer'), 'hello?')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    render(<KeyboardCheatSheet />)
    await user.keyboard('?')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
