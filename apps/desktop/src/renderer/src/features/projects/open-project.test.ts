import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openProjectViaPicker } from './open-project'

const { invokeFn } = vi.hoisted(() => ({ invokeFn: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: { invoke: invokeFn, subscribe: vi.fn(() => () => undefined) },
}))

const PICKED = '/code/picked'
const PROJECT = {
  id: 'proj_1',
  name: 'picked',
  path: PICKED,
  colorIndex: 0,
  createdAt: 1,
  lastOpenedAt: 2,
  open: true,
  status: 'ok' as const,
}

describe('openProjectViaPicker', () => {
  beforeEach(() => {
    invokeFn.mockReset()
  })

  it('opens the folder chosen in the native picker', async () => {
    invokeFn.mockImplementation(async (method: string) =>
      method === 'dialog.pickFolder' ? { path: PICKED } : PROJECT,
    )

    await expect(openProjectViaPicker()).resolves.toEqual(PROJECT)
    expect(invokeFn).toHaveBeenCalledWith('project.open', { path: PICKED })
  })

  it('is a clean no-op when the picker is cancelled', async () => {
    invokeFn.mockResolvedValue({ path: null })

    await expect(openProjectViaPicker()).resolves.toBeNull()
    // No project.open call, no thrown error: cancelling changes nothing.
    expect(invokeFn).toHaveBeenCalledTimes(1)
    expect(invokeFn).toHaveBeenCalledWith('dialog.pickFolder')
  })
})
