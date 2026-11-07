import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkRoutines } from './WorkRoutines'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  rpcMocks.invoke.mockReset()
})

describe('WorkRoutines', () => {
  it('reuses the original absolute time and receipt when a schedule call fails', async () => {
    let calls = 0
    rpcMocks.invoke.mockImplementation(async (method) => {
      if (method === 'orchestration.routine.list') return { routines: [] }
      if (method === 'orchestration.routine.add' && ++calls === 1)
        throw new Error('Connection lost')
      return {}
    })
    render(<WorkRoutines sessionId="lead" titleOf={() => undefined} />)
    await userEvent.click(screen.getByText('Scheduled prompts'))
    await userEvent.type(screen.getByLabelText('Prompt'), 'Check CI and report failures')
    await userEvent.click(screen.getByRole('button', { name: 'Schedule prompt' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    await userEvent.click(screen.getByRole('button', { name: 'Schedule prompt' }))
    await waitFor(() => expect(calls).toBe(2))
    const mutations = rpcMocks.invoke.mock.calls.filter(
      (call) => call[0] === 'orchestration.routine.add',
    )
    expect(mutations[0]?.[1]).toEqual(mutations[1]?.[1])
    expect(mutations[0]?.[1]).toEqual(
      expect.objectContaining({
        sessionId: 'lead',
        everyMs: null,
        prompt: 'Check CI and report failures',
      }),
    )
  })
  it('rejects repetition below the supported five-minute interval', async () => {
    rpcMocks.invoke.mockResolvedValue({ routines: [] })
    render(<WorkRoutines sessionId="lead" titleOf={() => undefined} />)
    await userEvent.click(screen.getByText('Scheduled prompts'))
    await userEvent.type(screen.getByLabelText('Prompt'), 'Check CI')
    await userEvent.clear(screen.getByLabelText('Repeat every minutes · 0 for once'))
    await userEvent.type(screen.getByLabelText('Repeat every minutes · 0 for once'), '2')
    expect(screen.getByRole('button', { name: 'Schedule prompt' })).toBeDisabled()
    expect(rpcMocks.invoke.mock.calls.some((call) => call[0] === 'orchestration.routine.add')).toBe(
      false,
    )
  })
})
