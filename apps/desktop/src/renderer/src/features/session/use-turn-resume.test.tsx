import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriverKind } from '@ari/contracts/common'
import { formatResumeTime } from './resume-time'
import { TurnErrorBanner } from './TurnErrorBanner'
import { useTurnResume } from './use-turn-resume'

const NOW = new Date(2026, 10, 8, 10).getTime()
const RESET_AT = NOW + 60_000.4
const SCHEDULED_AT = Math.round(RESET_AT)
const RESUME_LABEL = `Resume at ${formatResumeTime(RESET_AT, NOW)}`
const SCHEDULE_TEXT = `Ari will continue this session at ${formatResumeTime(SCHEDULED_AT, NOW)}.`

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function resolve<T>(request: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    request.resolve(value)
    await request.promise
  })
}

async function reject<T>(request: ReturnType<typeof deferred<T>>) {
  await act(async () => {
    request.reject(new Error('RPC unavailable'))
    await request.promise.catch(() => undefined)
  })
}

// Keep the real typed RPC client, hook, and banner; only the preload transport is a double.
const invoke = vi.fn<(method: string, params?: unknown) => Promise<unknown>>()
const onRetry = vi.fn()

function calls(method: string) {
  return invoke.mock.calls.filter(([name]) => name === method)
}

function Banner({ sessionId = 'a' }: { sessionId?: string }) {
  const resume = useTurnResume(sessionId, 'usage limit reached', 'claude')
  return (
    <TurnErrorBanner
      message="usage limit reached"
      canRetry
      retryDisabled={false}
      onRetry={onRetry}
      onDismiss={() => {}}
      resume={resume}
    />
  )
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  onRetry.mockReset()
  invoke.mockReset().mockImplementation(async (method) => {
    if (method === 'providers.allowance') {
      return {
        kind: 'claude',
        status: 'available',
        windows: [{ label: '5h', usedPercent: 100, resetsAt: RESET_AT }],
        updatedAt: NOW,
        checkedAt: NOW,
        detail: '',
      }
    }
    if (method === 'session.resume.get') return { at: null }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  window.ari = { invoke, subscribe: () => () => undefined }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('resume scheduling through the banner', () => {
  it('shows pending scheduling, reports rejection, and retries the schedule action', async () => {
    const schedule = deferred<{ at: number }>()
    const retry = deferred<{ at: number }>()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) => {
      if (method === 'session.resume.schedule')
        return calls(method).length === 1 ? schedule.promise : retry.promise
      return base(method, params)
    })
    const user = userEvent.setup()
    render(<Banner />)
    await user.click(await screen.findByRole('button', { name: RESUME_LABEL }))
    const pending = screen.getByRole('button', { name: 'Scheduling…' })
    expect(pending).toBeDisabled()
    fireEvent.click(pending)
    expect(calls('session.resume.schedule')).toEqual([
      ['session.resume.schedule', { sessionId: 'a', at: SCHEDULED_AT }],
    ])
    await reject(schedule)
    expect(screen.getByText('Could not confirm resume. Try again.')).toBeInTheDocument()
    expect(screen.queryByText(SCHEDULE_TEXT)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: RESUME_LABEL }))
    expect(screen.queryByText('Could not confirm resume. Try again.')).not.toBeInTheDocument()
    expect(onRetry).not.toHaveBeenCalled()
    await resolve(retry, { at: SCHEDULED_AT })
    expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
  })

  it('keeps the schedule after rejected cancellation and retries cancellation', async () => {
    const cancel = deferred<{ cancelled: boolean }>()
    const retry = deferred<{ cancelled: boolean }>()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) => {
      if (method === 'session.resume.get') return Promise.resolve({ at: SCHEDULED_AT })
      if (method === 'session.resume.cancel')
        return calls(method).length === 1 ? cancel.promise : retry.promise
      return base(method, params)
    })
    const user = userEvent.setup()
    render(<Banner />)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    const pending = screen.getByRole('button', { name: 'Cancelling…' })
    expect(pending).toBeDisabled()
    fireEvent.click(pending)
    expect(calls('session.resume.cancel')).toHaveLength(1)
    expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
    await reject(cancel)
    expect(screen.getByText('Could not cancel resume. Try again.')).toBeInTheDocument()
    expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: RESUME_LABEL })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onRetry).not.toHaveBeenCalled()
    // A successful RPC saying it was already absent also confirms cancellation.
    await resolve(retry, { cancelled: false })
    expect(screen.queryByText(SCHEDULE_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByText('Could not cancel resume. Try again.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: RESUME_LABEL })).toBeEnabled()
  })

  it('does not offer scheduling while the initial schedule is unknown', async () => {
    const lookup = deferred<{ at: number | null }>()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'session.resume.get' ? lookup.promise : base(method, params),
    )
    render(<Banner />)
    await waitFor(() => expect(calls('providers.allowance')).toHaveLength(1))
    expect(screen.getByText('Checking resume schedule…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: RESUME_LABEL })).not.toBeInTheDocument()
    await resolve(lookup, { at: SCHEDULED_AT })
    expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
    expect(calls('session.resume.schedule')).toHaveLength(0)
  })

  it('reports an unknown lookup and lets the keyboard recheck before scheduling', async () => {
    const lookup = deferred<{ at: number | null }>()
    const recheck = deferred<{ at: number | null }>()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) => {
      if (method === 'session.resume.get')
        return calls(method).length === 1 ? lookup.promise : recheck.promise
      return base(method, params)
    })
    const user = userEvent.setup()
    render(<Banner />)
    await reject(lookup)
    expect(screen.getByText('Could not check the resume schedule.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: RESUME_LABEL })).not.toBeInTheDocument()
    screen.getByRole('button', { name: 'Check schedule' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Checking resume schedule…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check schedule' })).not.toBeInTheDocument()
    expect(calls('session.resume.get')).toHaveLength(2)
    expect(calls('session.resume.schedule')).toHaveLength(0)
    expect(onRetry).not.toHaveBeenCalled()
    await resolve(recheck, { at: SCHEDULED_AT })
    expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
    expect(screen.queryByText('Could not check the resume schedule.')).not.toBeInTheDocument()
  })
})

describe('resume request ownership', () => {
  it.each(['schedule', 'cancel'] as const)(
    'blocks same-tick duplicate %s callbacks',
    async (action) => {
      const mutation = deferred<unknown>()
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation((method, params) => {
        if (method === 'session.resume.get')
          return Promise.resolve({ at: action === 'cancel' ? SCHEDULED_AT : null })
        if (method === `session.resume.${action}`) return mutation.promise
        return base(method, params)
      })
      const { result } = renderHook(() => useTurnResume('a', 'usage limit reached', 'claude'))
      await waitFor(() => expect(result.current?.resetAt).toBe(RESET_AT))
      const submit = action === 'schedule' ? result.current!.onSchedule : result.current!.onCancel
      act(() => {
        submit()
        submit()
        // Opposite mutations cannot race the pending one either.
        if (action === 'schedule') result.current!.onCancel()
        else result.current!.onSchedule()
      })
      expect(calls(`session.resume.${action}`)).toHaveLength(1)
      expect(calls(`session.resume.${action === 'schedule' ? 'cancel' : 'schedule'}`)).toHaveLength(
        0,
      )
      await resolve(mutation, action === 'schedule' ? { at: SCHEDULED_AT } : { cancelled: true })
      act(submit)
      expect(calls(`session.resume.${action}`)).toHaveLength(1)
    },
  )

  it('guards direct scheduling callbacks until the initial lookup succeeds', async () => {
    const lookup = deferred<{ at: number | null }>()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'session.resume.get' ? lookup.promise : base(method, params),
    )
    const { result } = renderHook(() => useTurnResume('a', 'usage limit reached', 'claude'))
    await waitFor(() => expect(result.current?.resetAt).toBe(RESET_AT))
    act(() => result.current!.onSchedule())
    expect(calls('session.resume.schedule')).toHaveLength(0)
    await reject(lookup)
    act(() => result.current!.onSchedule())
    expect(calls('session.resume.schedule')).toHaveLength(0)
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores an initial lookup that %ss after returning to the session and scheduling',
    async (outcome) => {
      const initial = deferred<{ at: number | null }>()
      const schedule = deferred<{ at: number }>()
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation((method, params) => {
        if (method === 'session.resume.get' && calls(method).length === 1) return initial.promise
        if (method === 'session.resume.schedule') return schedule.promise
        return base(method, params)
      })
      const { rerender } = render(<Banner sessionId="a" />)
      rerender(<Banner sessionId="b" />)
      rerender(<Banner sessionId="a" />)
      fireEvent.click(await screen.findByRole('button', { name: RESUME_LABEL }))
      await resolve(schedule, { at: SCHEDULED_AT })
      if (outcome === 'resolve') await resolve(initial, { at: null })
      else await reject(initial)
      expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: RESUME_LABEL })).not.toBeInTheDocument()
      expect(screen.queryByText('Could not check the resume schedule.')).not.toBeInTheDocument()
    },
  )

  it.each([
    ['schedule', 'resolve'],
    ['schedule', 'reject'],
    ['cancel', 'resolve'],
    ['cancel', 'reject'],
  ] as const)('ignores a late %s %s after switching sessions', async (action, outcome) => {
    const oldMutation = deferred<unknown>()
    const nextMutation = deferred<unknown>()
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) => {
      if (method === 'session.resume.get')
        return Promise.resolve({ at: action === 'cancel' ? SCHEDULED_AT : null })
      if (method === `session.resume.${action}`)
        return calls(method).length === 1 ? oldMutation.promise : nextMutation.promise
      return base(method, params)
    })
    const { rerender } = render(<Banner sessionId="a" />)
    const label = action === 'schedule' ? RESUME_LABEL : 'Cancel'
    fireEvent.click(await screen.findByRole('button', { name: label }))
    rerender(<Banner sessionId="b" />)
    fireEvent.click(await screen.findByRole('button', { name: label }))
    if (outcome === 'resolve')
      await resolve(oldMutation, action === 'schedule' ? { at: SCHEDULED_AT } : { cancelled: true })
    else await reject(oldMutation)
    expect(
      screen.getByRole('button', { name: action === 'schedule' ? 'Scheduling…' : 'Cancelling…' }),
    ).toBeDisabled()
    expect(screen.queryByText(/Could not (confirm|cancel) resume/)).not.toBeInTheDocument()
    await resolve(nextMutation, action === 'schedule' ? { at: SCHEDULED_AT } : { cancelled: true })
    if (action === 'schedule') expect(screen.getByText(SCHEDULE_TEXT)).toBeInTheDocument()
    else expect(screen.queryByText(SCHEDULE_TEXT)).not.toBeInTheDocument()
  })

  it.each(['provider change', 'error cleared', 'unmount'] as const)(
    'invalidates an outstanding mutation on %s',
    async (change) => {
      const schedule = deferred<{ at: number }>()
      const base = invoke.getMockImplementation()!
      invoke.mockImplementation((method, params) =>
        method === 'session.resume.schedule' ? schedule.promise : base(method, params),
      )
      const { result, rerender, unmount } = renderHook(
        ({ error, driver }: { error: string | null; driver: DriverKind }) =>
          useTurnResume('a', error, driver),
        {
          initialProps: {
            error: 'usage limit reached' as string | null,
            driver: 'claude' as DriverKind,
          },
        },
      )
      await waitFor(() => expect(result.current?.resetAt).toBe(RESET_AT))
      const submit = result.current!.onSchedule
      act(submit)
      if (change === 'provider change') rerender({ error: 'usage limit reached', driver: 'codex' })
      else if (change === 'error cleared') rerender({ error: null, driver: 'claude' })
      else unmount()
      await resolve(schedule, { at: SCHEDULED_AT })
      act(submit)
      expect(calls('session.resume.schedule')).toHaveLength(1)
      if (change === 'provider change') expect(result.current?.scheduledAt).toBeNull()
      if (change === 'error cleared') expect(result.current).toBeUndefined()
    },
  )
})
