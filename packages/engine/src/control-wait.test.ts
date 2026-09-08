import { expect, it, vi } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import { initialReadModel } from './projection'
import { waitForTurn } from './control-wait'

it('captures a settle emitted during the initial state read and releases the subscription', async () => {
  let listener: ((event: JournalEvent) => void) | null = null
  const event: JournalEvent = {
    type: 'turn.settled',
    sessionId: 's',
    turnId: 't',
    seq: 2,
    at: 2,
    stopReason: 'error',
    errorMessage: null,
  }
  const waiting = waitForTurn(
    {
      subscribe: (fn) => {
        listener = fn
        return () => {
          listener = null
        }
      },
      load: async () => {
        listener?.(event)
        return {
          ...initialReadModel(),
          activeTurnId: 't',
          session: {
            id: 's',
            projectId: 'p',
            title: 'S',
            driverKind: 'claude',
            modelId: null,
            permissionMode: 'ask',
            status: 'running',
            createdAt: 1,
            updatedAt: 1,
          },
        }
      },
    },
    's',
    100,
  )
  expect(await waiting).toMatchObject({ turnId: 't', stopReason: 'error' })
  expect(listener).toBeNull()
})

it('releases timeout and cancellation subscriptions without polling', async () => {
  vi.useFakeTimers()
  const unsubscribe = vi.fn()
  const load = async () => ({
    ...initialReadModel(),
    activeTurnId: 't',
    session: {
      id: 's',
      projectId: 'p',
      title: 'S',
      driverKind: 'claude' as const,
      modelId: null,
      permissionMode: 'ask' as const,
      status: 'running' as const,
      createdAt: 1,
      updatedAt: 1,
    },
  })
  try {
    const waiting = waitForTurn({ subscribe: () => unsubscribe, load }, 's', 100)
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'wait_timeout' })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(unsubscribe).toHaveBeenCalledOnce()
    const controller = new AbortController()
    const cancelled = waitForTurn(
      { subscribe: () => unsubscribe, load },
      's',
      100,
      controller.signal,
    )
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'wait_cancelled' })
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

it('returns a settle that landed while load observed an idle session', async () => {
  let listener: ((event: JournalEvent) => void) | null = null
  const event: JournalEvent = {
    type: 'turn.settled',
    sessionId: 's',
    turnId: 't',
    seq: 2,
    at: 2,
    stopReason: 'completed',
    errorMessage: null,
  }
  const session = {
    id: 's',
    projectId: 'p',
    title: 'S',
    driverKind: 'claude' as const,
    modelId: null,
    permissionMode: 'ask' as const,
    status: 'idle' as const,
    createdAt: 1,
    updatedAt: 1,
  }
  expect(
    await waitForTurn(
      {
        subscribe: (fn) => {
          listener = fn
          return () => {
            listener = null
          }
        },
        load: async () => {
          listener?.(event)
          return {
            ...initialReadModel(),
            activeTurnId: null,
            lastTurn: { turnId: 't', stopReason: 'completed' as const, settledAt: 2 },
            session,
          }
        },
      },
      's',
      100,
    ),
  ).toMatchObject({ status: 'settled', turnId: 't', stopReason: 'completed' })
})

it('wakes as destroyed when onGone fires', async () => {
  let gone: (() => void) | undefined
  const waiting = waitForTurn(
    {
      subscribe: () => () => undefined,
      load: async () => ({
        ...initialReadModel(),
        activeTurnId: 't',
        session: {
          id: 's',
          projectId: 'p',
          title: 'S',
          driverKind: 'claude',
          modelId: null,
          permissionMode: 'ask',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        },
      }),
      onGone: (_id, listener) => {
        gone = listener
        return () => undefined
      },
    },
    's',
    1_000,
  )
  gone?.()
  expect(await waiting).toMatchObject({ status: 'destroyed', sessionId: 's' })
})
