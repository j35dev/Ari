import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpeechProgress } from '@ari/contracts/rpc'
import { useSpeech } from './useSpeech'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(), off: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
afterEach(() => vi.clearAllMocks())

it('shares one subscription and reads status only after terminal progress', async () => {
  let publish: (frame: SpeechProgress) => void = () => undefined
  mocks.invoke.mockResolvedValue({ engine: 'ready', model: null, ready: false })
  mocks.subscribe.mockImplementation((_name, _params, callback) => {
    publish = callback
    return mocks.off
  })
  const first = renderHook(() => useSpeech())
  const second = renderHook(() => useSpeech())
  await waitFor(() => expect(first.result.current.status.engine).toBe('ready'))
  expect(mocks.subscribe).toHaveBeenCalledOnce()
  expect(mocks.invoke).toHaveBeenCalledOnce()
  act(() => {
    for (let received = 1; received <= 50; received++) {
      publish({ id: 'engine', phase: 'downloading', received, total: 100 })
    }
  })
  expect(first.result.current.progress['engine']?.received).toBe(50)
  expect(second.result.current.progress['engine']?.received).toBe(50)
  expect(mocks.invoke).toHaveBeenCalledOnce()
  await act(async () => publish({ id: 'engine', phase: 'complete', received: 100, total: 100 }))
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  first.unmount()
  expect(mocks.off).not.toHaveBeenCalled()
  second.unmount()
  expect(mocks.off).toHaveBeenCalledOnce()
})

it('ignores an old status response after the last subscriber unmounts', async () => {
  let finish: (status: unknown) => void = () => undefined
  mocks.subscribe.mockReturnValue(mocks.off)
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const first = renderHook(() => useSpeech())
  first.unmount()
  mocks.invoke.mockResolvedValue({ engine: 'missing', model: null, ready: false })
  const second = renderHook(() => useSpeech())
  await waitFor(() => expect(second.result.current.status.engine).toBe('missing'))
  await act(async () => finish({ engine: 'ready', model: null, ready: true }))
  expect(second.result.current.status.engine).toBe('missing')
  second.unmount()
})

it('applies status frames immediately without another RPC read', async () => {
  let publish: (frame: SpeechProgress) => void = () => undefined
  mocks.invoke.mockResolvedValue({ engine: 'missing', model: null, ready: false })
  mocks.subscribe.mockImplementation((_name, _params, callback) => {
    publish = callback
    return mocks.off
  })
  const hook = renderHook(() => useSpeech())
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce())
  await act(async () =>
    publish({
      id: 'configuration',
      phase: 'complete',
      received: 0,
      total: 0,
      status: { engine: 'ready', model: null, ready: true },
    }),
  )
  expect(hook.result.current.status.ready).toBe(true)
  expect(mocks.invoke).toHaveBeenCalledOnce()
  hook.unmount()
})

it('lets refresh settle after at most one rerun while status frames keep arriving', async () => {
  let publish: (frame: SpeechProgress) => void = () => undefined
  mocks.subscribe.mockImplementation((_name, _params, callback) => {
    publish = callback
    return mocks.off
  })
  mocks.invoke.mockResolvedValue({ engine: 'missing', model: null, ready: false })
  const hook = renderHook(() => useSpeech())
  await act(async () => {
    await hook.result.current.refresh()
  })
  mocks.invoke.mockClear()
  let remaining = 10
  mocks.invoke.mockImplementation(async () => {
    if (remaining-- > 0)
      publish({
        id: 'configuration',
        phase: 'complete',
        received: 0,
        total: 0,
        status: { engine: 'ready', model: null, ready: true },
      })
    return { engine: 'missing', model: null, ready: false }
  })
  let settled = false
  await act(async () => {
    await hook.result.current.refresh()
    settled = true
  })
  expect(settled).toBe(true)
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  expect(hook.result.current.status).toMatchObject({ engine: 'missing', ready: false })
  hook.unmount()
})
