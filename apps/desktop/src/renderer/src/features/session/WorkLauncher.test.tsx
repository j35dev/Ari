import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkLauncher } from './WorkLauncher'
import { workTask } from './work-fixtures.test-support'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  rpcMocks.invoke.mockReset()
})
const props = {
  sessionId: 'lead',
  defaults: { driverKind: 'codex' as const, modelId: null, permissionMode: 'ask' as const },
  onChanged: vi.fn(),
  onCancel: vi.fn(),
}

describe('WorkLauncher', () => {
  it('launches an isolated assignment with accepted-result prerequisites', async () => {
    rpcMocks.invoke.mockImplementation(async (method) =>
      method === 'providers.models' ? [] : method === 'session.load' ? { messages: [] } : {},
    )
    render(<WorkLauncher {...props} tasks={[workTask()]} />)
    await userEvent.type(screen.getByLabelText('Task title'), 'Search UI')
    await userEvent.type(screen.getByLabelText('Assignment'), 'Build the search form')
    await userEvent.type(
      screen.getByLabelText('Acceptance criteria, one per line'),
      'Keyboard navigation works',
    )
    await userEvent.click(screen.getByRole('checkbox', { name: 'Search API' }))
    await userEvent.click(screen.getByRole('button', { name: 'Launch task' }))
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith(
        'orchestration.launch',
        expect.objectContaining({
          workspaceMode: 'isolated',
          permissionMode: 'ask',
          assignment: expect.objectContaining({
            dependsOn: ['task-1'],
            goal: 'Build the search form',
            acceptanceCriteria: ['Keyboard navigation works'],
          }),
        }),
      ),
    )
  })

  it('blocks overlapping shared writers before sending a launch', async () => {
    rpcMocks.invoke.mockImplementation(async (method) =>
      method === 'providers.models' ? [] : { messages: [] },
    )
    render(<WorkLauncher {...props} tasks={[workTask({ workspaceMode: 'shared' })]} />)
    await userEvent.type(screen.getByLabelText('Task title'), 'Search fix')
    await userEvent.type(screen.getByLabelText('Assignment'), 'Fix search')
    await userEvent.type(screen.getByLabelText('Owned paths, one per line'), 'SRC\\search.ts')
    await userEvent.selectOptions(screen.getByLabelText('Workspace'), 'shared')
    expect(screen.getByRole('alert')).toHaveTextContent('overlap with Search API')
    expect(screen.getByRole('button', { name: 'Launch task' })).toBeDisabled()
    expect(rpcMocks.invoke.mock.calls.some((call) => call[0] === 'orchestration.launch')).toBe(
      false,
    )
  })
})
