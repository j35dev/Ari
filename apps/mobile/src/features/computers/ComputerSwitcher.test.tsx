// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComputerSwitcher } from './ComputerSwitcher'
const app = vi.hoisted(() => ({
  origin: 'https://studio.tailnet.ts.net:8443', connection: 'connected',
  computers: [{ origin: 'https://studio.tailnet.ts.net:8443', name: 'Studio', lastConnectedAt: 123 }, { origin: 'https://travel.tailnet.ts.net', name: 'Travel laptop', lastConnectedAt: null }],
  switchComputer: vi.fn(), addComputer: vi.fn(), changeComputer: vi.fn(),
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
describe('computer selector', () => {
  it('shows the selected computer and preserves the destination port', () => {
    const close = vi.fn()
    render(<ComputerSwitcher onClose={close} />)
    expect(screen.getByText('studio.tailnet.ts.net:8443')).toBeTruthy()
    expect(screen.getByLabelText('Selected computer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open computer: Travel laptop' }))
    expect(app.switchComputer).toHaveBeenCalledWith('https://travel.tailnet.ts.net')
    expect(close).toHaveBeenCalledOnce()
  })
  it('adds a public address and label without asking for device keys', () => {
    render(<ComputerSwitcher onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add computer' }))
    fireEvent.change(screen.getByLabelText('Tailscale address or pairing link'), { target: { value: 'https://third.tailnet.ts.net:8443/#pair=invite' } })
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Desk' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open computer' }))
    expect(app.addComputer).toHaveBeenCalledWith('https://third.tailnet.ts.net:8443/#pair=invite', 'Desk')
  })
  it('keeps a rejected address inline and does not dismiss the selector', () => {
    app.addComputer.mockImplementationOnce(() => { throw new Error('Use the Tailscale address.') })
    const close = vi.fn()
    render(<ComputerSwitcher onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add computer' }))
    fireEvent.change(screen.getByLabelText('Tailscale address or pairing link'), { target: { value: 'https://external.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open computer' }))
    expect(screen.getByRole('alert').textContent).toContain('Use the Tailscale address')
    expect(close).not.toHaveBeenCalled()
  })
})
