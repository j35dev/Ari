import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import type { SessionStartIntent } from './session-start-focus'
import { useSessionStart } from './use-session-start'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../lib/rpc', () => ({ rpc: rpcMocks }))

// A tooltip or menu opening while the draft is sent makes the focus intent stale.
const staleIntent = (): SessionStartIntent => ({
  scope: { spaceId: 'space', paneId: 'pane', sessionId: null },
  wantsFocus: false,
  isCurrent: () => false,
  validate: () => undefined,
  select: () => false,
  ready: () => undefined,
  dispose: () => undefined,
  cancel: () => undefined,
})

it('creates a draft session even when its focus intent went stale', async () => {
  rpcMocks.invoke.mockImplementation(async (method: string) =>
    method === 'session.create' ? { sessionId: 'created' } : undefined,
  )
  const { result } = renderHook(
    () =>
      useSessionStart({
        defaults: { driverKind: 'claude', modelId: 'opus', permissionMode: 'full', effort: null },
        sessions: [],
        captureIntent: staleIntent,
        onStarted: () => undefined,
        refreshProjects: () => undefined,
        refreshSessions: () => undefined,
        checkSessions: async () => undefined,
      }),
    { wrapper: ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider> },
  )
  let id: string | undefined
  await act(async () => {
    id = await result.current.createDraft('project', {})
  })
  expect(id).toBe('created')
  expect(rpcMocks.invoke).toHaveBeenCalledWith('session.create', expect.objectContaining({ projectId: 'project' }))
})

it('leaves a failed draft start to the draft, so the next start is not refused', async () => {
  let fail = true
  rpcMocks.invoke.mockReset()
  rpcMocks.invoke.mockImplementation(async (method: string) => {
    if (method !== 'session.create') return undefined
    if (fail) throw new Error('Creation reply lost')
    return { sessionId: 'second' }
  })
  const { result } = renderHook(
    () =>
      useSessionStart({
        defaults: { driverKind: 'claude', modelId: 'opus', permissionMode: 'full', effort: null },
        sessions: [],
        captureIntent: staleIntent,
        onStarted: () => undefined,
        refreshProjects: () => undefined,
        refreshSessions: () => undefined,
        checkSessions: async () => undefined,
      }),
    { wrapper: ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider> },
  )
  await act(async () => {
    await expect(result.current.createDraft('project', {})).rejects.toThrow('Creation reply lost')
  })
  expect(result.current.canStart()).toBe(true)
  fail = false
  let id: string | undefined
  await act(async () => {
    id = await result.current.createDraft('project', {})
  })
  expect(id).toBe('second')
})
