import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MachinesProvider } from './use-machines'
import { RemoteWorkspace } from './RemoteWorkspace'
import { MachineChooser } from './MachineChooser'
import { machineFixture, catalogFixture } from './fixtures.test-support'
import { readCreationDraft, writeCreationDraft } from './remote-drafts'
import { readReceipt } from './remote-client'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn<
    (name: string, params: Record<string, unknown>, listener: (raw: unknown) => void) => () => void
  >(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('./RemoteSession', () => ({ RemoteSession: () => null }))
const reply = (result: unknown) => ({ ok: true, result })
let hosts = [machineFixture(), machineFixture('host-b')]

describe('host session creation', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.invoke.mockReset()
    hosts = [machineFixture(), machineFixture('host-b')]
    mocks.invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.list') return hosts
      if (method === 'machines.command') return reply({ sessionId: 'created-on-host' })
      if (params.query.op === 'models.list') return reply(catalogFixture)
      if (params.query.op === 'project.list')
        return reply([
          { id: 'host-project-1', name: 'Host project', sessionCount: 0 },
          { id: 'host-project-2', name: 'Second host project', sessionCount: 0 },
        ])
      if (params.query.op === 'session.list') return reply([])
      throw new Error('unexpected operation')
    })
  })
  it('chooses the computer before host projects, disables offline hosts, and keeps local choice explicit', async () => {
    const choose = vi.fn()
    const user = userEvent.setup()
    render(
      <MachineChooser
        machines={[hosts[0]!, { ...hosts[1]!, status: 'offline' }]}
        onChoose={choose}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Build computer/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /Studio computer/ }))
    expect(choose).toHaveBeenCalledWith('host-a')
    await user.click(screen.getByRole('button', { name: /This computer/ }))
    expect(choose).toHaveBeenCalledWith(null)
  })
  it('persists project, title, model, permissions and effort per host through switching and offline', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const show = (id: string) => (
      <MachinesProvider>
        <RemoteWorkspace
          target={{ machineId: id, sessionId: null }}
          onSelect={onSelect}
          onBack={vi.fn()}
          onManage={vi.fn()}
        />
      </MachinesProvider>
    )
    const { rerender } = render(show('host-a'))
    await screen.findByRole('option', { name: 'Second host project' })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Host project' }),
      'host-project-2',
    )
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), 'Creation A')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Permissions' }), 'allow-edits')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reasoning effort' }), 'high')
    rerender(show('host-b'))
    await screen.findByRole('heading', { name: 'New session on Build computer' })
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), 'Creation B')
    rerender(show('host-a'))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveValue('Creation A'),
    )
    expect(screen.getByRole('combobox', { name: 'Host project' })).toHaveValue('host-project-2')
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('high')
    await user.click(screen.getByRole('button', { name: 'Create on Studio computer' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('host-a', 'created-on-host'))
    const command = mocks.invoke.mock.calls.find(([method]) => method === 'machines.command')![1]
    expect(command.machineId).toBe('host-a')
    expect(command.command).toMatchObject({
      op: 'session.create',
      projectId: 'host-project-2',
      title: 'Creation A',
      driverKind: 'codex',
      modelId: 'gpt-6.1-sol',
      permissionMode: 'allow-edits',
      effort: 'high',
    })
    expect(readCreationDraft('host-b').title).toBe('Creation B')
    hosts = hosts.map((host) =>
      host.id === 'host-b' ? { ...host, status: 'offline' as const } : host,
    )
    const listener = mocks.subscribe.mock.calls.find(
      (call) => call[0] === 'machines.updates',
    )?.[2] as ((raw: unknown) => void) | undefined
    act(() => listener?.(hosts))
    rerender(show('host-b'))
    expect(await screen.findByRole('textbox', { name: 'Session name' })).toHaveValue('Creation B')
    expect(screen.getByRole('button', { name: 'Create on Build computer' })).toBeDisabled()
  })
  it('preserves a newer creation draft when the old host completion arrives after switching', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    let complete!: (result: unknown) => void
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((method, params) =>
      method === 'machines.command'
        ? new Promise((resolve) => {
            complete = resolve
          })
        : original(method, params),
    )
    const show = (machineId: string) => (
      <MachinesProvider>
        <RemoteWorkspace
          target={{ machineId, sessionId: null }}
          onSelect={onSelect}
          onBack={vi.fn()}
          onManage={vi.fn()}
        />
      </MachinesProvider>
    )
    const { rerender } = render(show('host-a'))
    await screen.findByRole('option', { name: 'Host project' })
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), 'Submitted A')
    await user.click(screen.getByRole('button', { name: 'Create on Studio computer' }))
    rerender(show('host-b'))
    await screen.findByRole('heading', { name: 'New session on Build computer' })
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), 'Unsent B')
    // Another visit/window may replace A's draft while its old request is in flight.
    const newer = { ...readCreationDraft('host-a'), title: 'New unsent A' }
    writeCreationDraft('host-a', newer)
    rerender(show('host-a'))
    await screen.findByRole('textbox', { name: 'Session name' })
    await act(async () => complete(reply({ sessionId: 'created-on-host' })))
    expect(readCreationDraft('host-a')).toEqual(newer)
    expect(readCreationDraft('host-b').title).toBe('Unsent B')
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveValue('New unsent A')
    expect(onSelect).not.toHaveBeenCalled()
  })
  it('does not clear a newer creation draft when checking an older saved receipt', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.command')
        return { ok: false, error: { code: 'internal_error', message: 'Creation unknown' } }
      if (params?.query?.op === 'command.status') return reply({ sessionId: 'confirmed-original' })
      return original(method, params)
    })
    const show = () => (
      <MachinesProvider>
        <RemoteWorkspace
          target={{ machineId: 'host-a', sessionId: null }}
          onSelect={onSelect}
          onBack={vi.fn()}
          onManage={vi.fn()}
        />
      </MachinesProvider>
    )
    const first = render(show())
    await screen.findByRole('option', { name: 'Host project' })
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), 'Original A')
    await user.click(screen.getByRole('button', { name: 'Create on Studio computer' }))
    await screen.findByRole('button', { name: 'Check creation' })
    first.unmount()
    const newer = { ...readCreationDraft('host-a'), title: 'Next A' }
    writeCreationDraft('host-a', newer)
    render(show())
    await screen.findByRole('button', { name: 'Check creation' })
    await user.click(screen.getByRole('button', { name: 'Check creation' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('host-a', 'confirmed-original'))
    expect(readCreationDraft('host-a')).toEqual(newer)
    expect(readReceipt('host-a', 'new-session')).toBeNull()
    expect(
      mocks.invoke.mock.calls.filter(([method]) => method === 'machines.command'),
    ).toHaveLength(1)
  })
})
