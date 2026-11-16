import { beforeEach, expect, it, vi } from 'vitest'
import { localProjectDraftClient } from './project-draft-adapter'

const rpc = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => {}) }))
vi.mock('../../lib/rpc', () => ({ rpc }))

const summary = (id: string, projectId: string, messageCount: number, updatedAt: number) =>
  ({ id, projectId, title: 'New session', messageCount, updatedAt })
const client = () => localProjectDraftClient({
  catalog: vi.fn(),
  create: vi.fn(),
})
beforeEach(() => rpc.invoke.mockReset())

it('finds the empty session an unconfirmed local start left behind', async () => {
  rpc.invoke.mockResolvedValue([
    summary('older', 'project', 0, 1), summary('used', 'project', 3, 9),
    summary('newer', 'project', 0, 5), summary('elsewhere', 'other', 0, 8),
  ])
  await expect(client().checkCreate('draft', 'project')).resolves.toEqual({ kind: 'local', sessionId: 'newer' })
})

it('reports that nothing was created when This PC has no empty session for the project', async () => {
  rpc.invoke.mockResolvedValue([summary('used', 'project', 2, 1), summary('elsewhere', 'other', 0, 2)])
  await expect(client().checkCreate('draft', 'project')).resolves.toBe('not-created')
})
