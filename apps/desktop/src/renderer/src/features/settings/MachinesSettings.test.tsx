import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MachinesSettings } from './MachinesSettings'
import { MachinesProvider } from '../machines/use-machines'
import { machineFixture } from '../machines/fixtures.test-support'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))

describe('Machines settings', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(async (method) => (method === 'machines.list' ? [] : undefined))
  })
  it('adds a tailnet link and discovers peers without pairing automatically', async () => {
    const user = userEvent.setup()
    const host = machineFixture()
    mocks.invoke.mockImplementation(async (method) => {
      if (method === 'machines.list') return []
      if (method === 'machines.discover')
        return [{ name: host.name, routes: host.routes, identity: host.identity }]
      if (method === 'machines.add') return host
      throw new Error('unexpected mutation')
    })
    render(
      <MachinesProvider>
        <MachinesSettings />
      </MachinesProvider>,
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Tailnet URL or pairing link' }),
      'https://host-a.example.ts.net/#pair=invitation',
    )
    await user.click(screen.getByRole('button', { name: 'Add computer' }))
    expect(mocks.invoke).toHaveBeenCalledWith('machines.add', {
      address: 'https://host-a.example.ts.net/#pair=invitation',
    })
    await user.click(screen.getByRole('button', { name: 'Discover computers' }))
    await screen.findByText(host.name)
    expect(mocks.invoke.mock.calls.some(([method]) => method === 'machines.pair')).toBe(false)
  })
  it('shows the confirmation code and waits for host approval, then labels the authenticated terminal grant', async () => {
    const user = userEvent.setup()
    const host = { ...machineFixture(), status: 'unpaired' as const }
    mocks.invoke.mockImplementation(async (method) => {
      if (method === 'machines.list') return [host]
      if (method === 'machines.pair') {
        host.status = 'pairing' as 'unpaired'
        return {
          machineId: host.id,
          status: 'pairing',
          confirmationCode: 'ABCD-EFGH',
          expiresAt: 1_790_000_000_000,
          error: null,
        }
      }
      if (method === 'machines.pairStatus')
        return {
          machineId: host.id,
          status: 'pairing',
          confirmationCode: 'ABCD-EFGH',
          expiresAt: 1_790_000_000_000,
          error: null,
        }
      throw new Error('unexpected RPC')
    })
    render(
      <MachinesProvider>
        <MachinesSettings />
      </MachinesProvider>,
    )
    await user.type(
      await screen.findByRole('textbox', { name: 'Pairing code from host' }),
      'ABCD1234',
    )
    await user.click(screen.getByRole('button', { name: 'Request pairing' }))
    await screen.findByText('Waiting for host approval')
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.getByText(/Terminal not granted/)).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('machines.pair', {
      machineId: 'host-a',
      displayName: 'Ari desktop',
      code: 'ABCD1234',
    })
    expect(mocks.invoke.mock.calls.some(([method]) => method === 'remote.approve')).toBe(false)
  })
  it('renames and reconnects the selected machine, and removes only after a concrete confirmation', async () => {
    const host = machineFixture()
    const user = userEvent.setup()
    const onOpen = vi.fn()
    mocks.invoke.mockImplementation(async (method) => (method === 'machines.list' ? [host] : host))
    render(
      <MachinesProvider>
        <MachinesSettings onOpenMachine={onOpen} />
      </MachinesProvider>,
    )
    const name = await screen.findByRole('textbox', { name: `Name for ${host.name}` })
    await user.clear(name)
    await user.type(name, 'Build workstation')
    await user.click(screen.getByRole('button', { name: 'Rename', exact: true }))
    expect(mocks.invoke).toHaveBeenCalledWith('machines.rename', {
      machineId: 'host-a',
      name: 'Build workstation',
    })
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(mocks.invoke).toHaveBeenCalledWith('machines.connect', { machineId: 'host-a' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open workspace' })).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Open workspace' }))
    expect(onOpen).toHaveBeenCalledWith('host-a')
    await user.click(screen.getByRole('button', { name: 'Remove', exact: true }))
    expect(mocks.invoke.mock.calls.some(([method]) => method === 'machines.remove')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Remove computer', exact: true }))
    expect(mocks.invoke).toHaveBeenCalledWith('machines.remove', { machineId: 'host-a' })
  })
})
