// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { initialReadModel } from '@ari/engine/projection'
import type { Session } from '@ari/contracts/session'
import { queryAriaOverview } from './aria-overview'
import { RpcRegistry } from './rpc-registry'

const session: Session = {
  id: 'aria',
  projectId: 'helm',
  title: 'Aria',
  driverKind: 'codex',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}

it('loads the requested Aria journal and resolves project names through the RPC', async () => {
  const worker = { ...session, id: 'worker', projectId: 'web', title: 'Fix login' }
  const store = {
    load: vi.fn(async (id: string) => ({
      ...initialReadModel(),
      session: id === 'aria' ? session : worker,
      activeTurnId: id === 'worker' ? 't' : null,
    })),
    listSessions: vi.fn(async () => [
      { ...worker, archived: false, pinned: false, messageCount: 1, lastMessagePreview: null },
    ]),
  }
  const registry = new RpcRegistry({ send: () => {} })
  registry.register('aria.overview', ({ sessionId }) =>
    queryAriaOverview(store, [{ projectId: 'web', name: 'Website' }], sessionId),
  )
  await expect(registry.invoke('aria.overview', { sessionId: 'aria' })).resolves.toMatchObject({
    running: [{ sessionId: 'worker', projectName: 'Website' }],
    needsYou: [],
    doneToday: [],
  })
  expect(store.load).toHaveBeenCalledWith('aria')
  await expect(registry.invoke('aria.overview', { sessionId: '' })).rejects.toThrow(
    'invalid params',
  )
})

it('rejects missing and ordinary sessions before listing the projects work', async () => {
  for (const target of [null, { ...session, projectId: 'web' }]) {
    const store = {
      load: vi.fn(async () => ({ ...initialReadModel(), session: target })),
      listSessions: vi.fn(async () => []),
    }
    await expect(queryAriaOverview(store, [], 'other')).rejects.toThrow('requires an Aria session')
    expect(store.listSessions).not.toHaveBeenCalled()
  }
})
