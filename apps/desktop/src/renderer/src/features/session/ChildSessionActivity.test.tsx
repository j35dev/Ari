import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { SessionActivity } from './session-activity'
import type { SessionSummary } from '@ari/contracts/rpc'
import { ChildSessionActivity } from './ChildSessionActivity'

const child = (id: string, title: string): SessionSummary => ({
  id,
  title,
  projectId: 'p',
  updatedAt: 1,
  messageCount: 0,
  parentSessionId: 'root',
  status: 'idle',
})

it('hides when no live children remain', () => {
  const { rerender } = render(<ChildSessionActivity sessions={[child('a', 'Audit A')]} />)
  expect(screen.getByRole('button', { name: 'Child sessions' })).toHaveTextContent('1 child')
  rerender(<ChildSessionActivity sessions={[]} />)
  expect(screen.queryByRole('button', { name: 'Child sessions' })).not.toBeInTheDocument()
})

it('expands live children in the composer cap and navigates on click', async () => {
  const open = vi.fn()
  render(
    <ChildSessionActivity
      onOpen={open}
      sessions={[child('a', 'Audit A'), child('b', 'Audit B')]}
      activityOf={(id) => (id === 'a' ? { phase: 'working', startedAt: 1 } : undefined)}
    />,
  )
  expect(screen.queryByRole('list', { name: 'Child sessions' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Child sessions' }))
  expect(screen.getByRole('list', { name: 'Child sessions' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Audit A/ })).toHaveTextContent('working')
  await userEvent.click(screen.getByRole('button', { name: /Audit B/ }))
  expect(open).toHaveBeenCalledWith('b')
})

it('offers to stop all delegated work only when the caller says there is some', async () => {
  const stop = vi.fn()
  const { rerender } = render(<ChildSessionActivity sessions={[child('a', 'Audit A')]} />)
  expect(screen.queryByRole('button', { name: 'Stop all' })).not.toBeInTheDocument()
  rerender(<ChildSessionActivity sessions={[child('a', 'Audit A')]} onStopAll={stop} />)
  await userEvent.click(screen.getByRole('button', { name: 'Stop all' }))
  expect(stop).toHaveBeenCalledOnce()
})

it('says which child is waiting on the user and opens it in one press', async () => {
  const open = vi.fn()
  render(
    <ChildSessionActivity
      onOpen={open}
      sessions={[child('a', 'Audit A'), child('b', 'Audit B')]}
      activityOf={(id) =>
        id === 'b' ? { phase: 'paused', startedAt: 1, pauseReason: 'approval' } : undefined
      }
    />,
  )
  expect(screen.getByRole('button', { name: 'Child sessions' })).toHaveTextContent(
    'Audit B needs you',
  )
  await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
  expect(open).toHaveBeenCalledWith('b')
})

it('labels queued children in the rail and expanded rows until execution starts', async () => {
  const view = (activity: SessionActivity) => (
    <ChildSessionActivity sessions={[child('a', 'Audit A')]} activityOf={() => activity} />
  )
  const { rerender } = render(view({ phase: 'queued', startedAt: null }))
  const rail = screen.getByRole('button', { name: 'Child sessions' })
  expect(rail).toHaveTextContent('1 queued')
  expect(rail).not.toHaveTextContent('idle')
  await userEvent.click(rail)
  expect(screen.getByRole('status', { name: 'Queued' })).toBeInTheDocument()
  expect(screen.getByText('Audit A').closest('button')).toHaveTextContent('queued')
  expect(screen.queryByText('working')).not.toBeInTheDocument()
  rerender(view({ phase: 'working', startedAt: 10 }))
  expect(rail).toHaveTextContent('1 working')
  expect(rail).not.toHaveTextContent('queued')
  expect(screen.getByRole('status', { name: 'Working' })).toBeInTheDocument()
})

it('counts queued and executing children separately while preserving an attention prompt', () => {
  render(
    <ChildSessionActivity
      sessions={[child('a', 'Audit A'), child('b', 'Audit B'), child('c', 'Audit C')]}
      activityOf={(id) =>
        id === 'a'
          ? { phase: 'working', startedAt: 10 }
          : id === 'b'
            ? { phase: 'queued', startedAt: null }
            : { phase: 'paused', startedAt: 10, pauseReason: 'input' }
      }
    />,
  )
  const rail = screen.getByRole('button', { name: 'Child sessions' })
  expect(rail).toHaveTextContent('1 working')
  expect(rail).toHaveTextContent('1 queued')
  expect(rail).toHaveTextContent('Audit C needs you')
})
