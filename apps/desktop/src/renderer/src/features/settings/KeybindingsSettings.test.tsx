import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { KeybindingsSettings } from './KeybindingsSettings'

function stubPlatform(value: string): void {
  Object.defineProperty(window.navigator, 'platform', { value, configurable: true })
}

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'platform')
})

describe('KeybindingsSettings', () => {
  it('renders one row per logical shortcut', () => {
    stubPlatform('Win32')
    render(<KeybindingsSettings />)

    for (const label of [
      'Toggle command palette',
      'New session',
      'Close palette',
      'Cycle theme',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('shows Cmd chords on Apple platforms', () => {
    stubPlatform('MacIntel')
    render(<KeybindingsSettings />)

    const paletteRow = screen.getByText('Toggle command palette').closest('li')
    expect(within(paletteRow as HTMLElement).getByText('Cmd')).toBeInTheDocument()
    expect(within(paletteRow as HTMLElement).getByText('K')).toBeInTheDocument()

    const themeRow = screen.getByText('Cycle theme').closest('li')
    expect(within(themeRow as HTMLElement).getByText('Cmd')).toBeInTheDocument()
    expect(within(themeRow as HTMLElement).getByText('Shift')).toBeInTheDocument()
    expect(within(themeRow as HTMLElement).getByText('T')).toBeInTheDocument()
  })

  it('shows Ctrl chords on Windows platforms', () => {
    stubPlatform('Win32')
    render(<KeybindingsSettings />)

    const paletteRow = screen.getByText('Toggle command palette').closest('li')
    expect(within(paletteRow as HTMLElement).getByText('Ctrl')).toBeInTheDocument()
    expect(within(paletteRow as HTMLElement).getByText('K')).toBeInTheDocument()

    const sessionRow = screen.getByText('New session').closest('li')
    expect(within(sessionRow as HTMLElement).getByText('Ctrl')).toBeInTheDocument()
    expect(within(sessionRow as HTMLElement).getByText('N')).toBeInTheDocument()
  })

  it('renders non-modifier chords untouched', () => {
    stubPlatform('Win32')
    render(<KeybindingsSettings />)

    const closeRow = screen.getByText('Close palette').closest('li')
    expect(within(closeRow as HTMLElement).getByText('Escape')).toBeInTheDocument()
    expect(within(closeRow as HTMLElement).queryByText('Ctrl')).not.toBeInTheDocument()
  })

  it('notes that remapping ships with the keybindings layer', () => {
    render(<KeybindingsSettings />)
    expect(
      screen.getByText(/remapping lands with the keybindings layer/),
    ).toBeInTheDocument()
  })
})
