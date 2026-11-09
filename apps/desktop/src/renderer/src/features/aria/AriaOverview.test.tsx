import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcResults } from '@ari/contracts/rpc'
import { AriaOverview } from './AriaOverview'

type Overview = RpcResults['aria.overview']
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))

let fire: (payload: unknown) => void
const empty: Overview = {
  needsYou: [],
  running: [],
  doneToday: [],
  more: { needsYou: 0, running: 0, doneToday: 0 },
}
const base = {
  sessionId: 's',
  title: 'Fix login',
  projectId: 'web',
  projectName: 'Website',
  updatedAt: 1,
}

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(empty)
  mocks.unsubscribe.mockReset()
  mocks.subscribe.mockReset().mockImplementation((_name, _params, handler: typeof fire) => {
    fire = handler
    return mocks.unsubscribe
  })
})
afterEach(() => {
  vi.useRealTimers()
})

it('renders nothing when no section has work', async () => {
  const { container } = render(<AriaOverview sessionId="aria" onOpenSession={() => {}} />)
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('aria.overview', { sessionId: 'aria' }),
  )
  expect(container).toBeEmptyDOMElement()
})

it('shows slim rows, decision kinds, project names, report text and ages, and opens the selected session', async () => {
  const onOpen = vi.fn()
  mocks.invoke.mockResolvedValue({
    ...empty,
    needsYou: [{ ...base, requestId: 'a', kind: 'approval', summary: 'Allow build' }],
    running: [
      {
        ...base,
        sessionId: 'r',
        title: 'Build settings',
        state: 'working',
        startedByAria: true,
        startedAt: Date.now() - 4 * 60_000,
      },
    ],
    doneToday: [
      {
        ...base,
        sessionId: 'd',
        title: 'Write tests',
        report: 'Covered logout.',
        settledAt: Date.now() - 2 * 3_600_000,
      },
    ],
  } satisfies Overview)
  render(<AriaOverview sessionId="aria" onOpenSession={onOpen} />)
  expect(await screen.findByRole('region', { name: 'Needs you' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Fix login/ })).toHaveAttribute('title', 'Allow build')
  expect(screen.getByText('approval')).toBeInTheDocument()
  expect(screen.getAllByText('Website')).toHaveLength(3)
  expect(screen.getByText('Covered logout.')).toBeInTheDocument()
  expect(screen.getByText('4m')).toBeInTheDocument()
  expect(screen.getByText('2h')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Build settings/ })).toHaveAttribute(
    'title',
    'Started by Aria',
  )
  await userEvent.click(screen.getByRole('button', { name: /Write tests/ }))
  expect(onOpen).toHaveBeenCalledWith('d')
})

it('shows five rows per section and expands each independently with overflow counts', async () => {
  mocks.invoke.mockResolvedValue({
    ...empty,
    needsYou: Array.from({ length: 7 }, (_, i) => ({
      ...base,
      requestId: `q${i}`,
      kind: 'question' as const,
      summary: 'Which option?',
    })),
    running: Array.from({ length: 6 }, (_, i) => ({
      ...base,
      sessionId: `r${i}`,
      title: `Task ${i}`,
      state: 'queued' as const,
      startedByAria: false,
      startedAt: null,
    })),
    more: { ...empty.more, needsYou: 2 },
  } satisfies Overview)
  render(<AriaOverview sessionId="aria" onOpenSession={() => {}} />)
  const needs = await screen.findByRole('region', { name: 'Needs you' })
  const running = screen.getByRole('region', { name: 'Running' })
  expect(within(needs).getAllByRole('button')).toHaveLength(6)
  expect(within(needs).getByRole('button', { name: 'Show more needs you' })).toHaveTextContent(
    '+4 more',
  )
  expect(screen.queryByRole('region', { name: 'Done today' })).toBeNull()
  await userEvent.click(within(needs).getByRole('button', { name: 'Show more needs you' }))
  expect(within(needs).getAllByRole('button')).toHaveLength(7)
  expect(within(needs).getByText('+2 more')).toBeInTheDocument()
  expect(within(running).getAllByRole('button')).toHaveLength(6)
  await userEvent.click(within(running).getByRole('button', { name: 'Show more running' }))
  expect(screen.getByText('Task 5')).toBeInTheDocument()
})

it('coalesces live decisions, turns, queues and child reports while ignoring replay and streaming noise', async () => {
  vi.useFakeTimers()
  const { unmount } = render(<AriaOverview sessionId="aria" onOpenSession={() => {}} />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(mocks.subscribe).toHaveBeenCalledWith('session.events', {}, expect.any(Function))
  act(() => {
    fire({ replay: true, event: { type: 'turn.started' } })
    fire({ replayDone: true })
    fire({ event: { type: 'assistant.parts.appended' } })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  act(() => {
    for (const type of [
      'approval.requested',
      'input.responded',
      'turn.started',
      'message.enqueued',
      'child.session.settled',
      'session.updated',
    ])
      fire({ sessionId: 'another-project', event: { type } })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(249)
  })
  expect(mocks.invoke).toHaveBeenCalledTimes(1)
  mocks.invoke.mockResolvedValue({
    ...empty,
    needsYou: [{ ...base, requestId: 'q', kind: 'question', summary: 'Which?' }],
  } satisfies Overview)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  expect(screen.getByText('question')).toBeInTheDocument()
  act(() => {
    fire({ event: { type: 'turn.settled' } })
  })
  unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(mocks.invoke).toHaveBeenCalledTimes(2)
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('ignores stale responses after changing Aria topics', async () => {
  let resolveOld!: (value: Overview) => void
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise<Overview>((resolve) => {
        resolveOld = resolve
      }),
  )
  const { rerender } = render(<AriaOverview sessionId="old" onOpenSession={() => {}} />)
  rerender(<AriaOverview sessionId="new" onOpenSession={() => {}} />)
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith('aria.overview', { sessionId: 'new' }),
  )
  await act(async () => {
    resolveOld({
      ...empty,
      needsYou: [{ ...base, requestId: 'q', kind: 'question', summary: 'Old question' }],
    })
  })
  expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
})
