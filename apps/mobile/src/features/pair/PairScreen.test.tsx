// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computerAddress } from '../../lib/computers'
import { PairScreen } from './PairScreen'

const app = vi.hoisted(() => ({
  connection: 'unpaired', session: null, error: null,
  addComputer: vi.fn<(address: string) => void>(),
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))
vi.mock('../computers/ComputerSwitcher', () => ({ ComputerButton: () => null }))
beforeEach(() => { app.addComputer.mockImplementation((address) => { computerAddress(address) }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

it.each(['https://studio.tailnet.ts.net:8443/#pair=invitation', 'http://127.0.0.1:5273/'])(
  'uses the computer switcher for the complete private destination %s', (address) => {
    render(<PairScreen invitationId={null} onInvitation={vi.fn()} />)
    fireEvent.click(screen.getByText("Already have your computer's address?"))
    fireEvent.change(screen.getByRole('textbox', { name: 'Desktop address' }), { target: { value: address } })
    fireEvent.click(screen.getByRole('button', { name: 'Open computer' }))
    expect(app.addComputer).toHaveBeenCalledExactlyOnceWith(address)
    expect(screen.queryByRole('alert')).toBeNull()
  },
)

it.each(['https://external.example/', 'https://user:secret@studio.ts.net/', 'https://studio.ts.net/api'])(
  'shows the common destination-policy error for %s', (address) => {
    render(<PairScreen invitationId={null} onInvitation={vi.fn()} />)
    fireEvent.click(screen.getByText("Already have your computer's address?"))
    fireEvent.change(screen.getByRole('textbox', { name: 'Desktop address' }), { target: { value: address } })
    fireEvent.click(screen.getByRole('button', { name: 'Open computer' }))
    expect(screen.getByRole('alert')).toBeTruthy()
  },
)
