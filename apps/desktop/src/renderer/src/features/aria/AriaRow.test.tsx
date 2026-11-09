import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AriaRow } from './AriaRow'
import { ariaActivity, startedByAria } from './aria-activity'
import type { SessionSummary } from '@ari/contracts/rpc'

vi.mock('@ari/ui/aria-mark', () => ({
  AriaMark: ({ state }: { state: string }) => <svg data-aria-state={state} />,
}))

const sessions: SessionSummary[] = [
  { id: 'aria', projectId: 'helm', title: 'Aria', messageCount: 1, updatedAt: 1 },
  { id: 'past', projectId: 'helm', title: 'Past', messageCount: 1, updatedAt: 1, archived: true },
  {
    id: 'worker',
    projectId: 'project',
    title: 'Worker',
    messageCount: 1,
    updatedAt: 1,
    createdBy: { kind: 'session', sessionId: 'past' },
  },
  { id: 'another', projectId: 'other', title: 'Another', messageCount: 1, updatedAt: 1 },
]

it('opens Aria, shows selected styling and prioritizes attention over running counts', async () => {
  const onOpen = vi.fn()
  const activity = ariaActivity(sessions, (id) =>
    id === 'worker'
      ? { phase: 'working', startedAt: 1 }
      : id === 'another'
        ? { phase: 'paused', startedAt: 1, pauseReason: 'approval' }
        : undefined,
  )
  const { container } = render(<AriaRow selected activity={activity} onOpen={onOpen} />)
  expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveAttribute('aria-current', 'page')
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'attention')
  expect(screen.getByTitle('1 items need you')).toHaveTextContent('1')
  expect(screen.queryByTitle('1 sessions working')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Open Aria' }))
  expect(onOpen).toHaveBeenCalledOnce()
})

it('derives idle, own thinking and started-session working states from live activity', () => {
  const { container, rerender } = render(
    <AriaRow
      selected={false}
      activity={ariaActivity(sessions, () => undefined)}
      onOpen={() => {}}
    />,
  )
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'idle')
  expect(screen.queryByText('0')).toBeNull()
  expect(screen.getByRole('button')).not.toHaveAttribute('aria-current')
  const working = ariaActivity(sessions, (id) =>
    id === 'worker' ? { phase: 'working', startedAt: 1 } : undefined,
  )
  rerender(<AriaRow selected={false} activity={working} onOpen={() => {}} />)
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'working')
  expect(screen.getByTitle('1 sessions working')).toHaveTextContent('1')
  const thinking = ariaActivity(sessions, (id) =>
    id === 'aria' || id === 'worker' ? { phase: 'working', startedAt: 1 } : undefined,
  )
  rerender(<AriaRow selected={false} activity={thinking} onOpen={() => {}} />)
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'thinking')
})

it('attributes only top-level sessions to creators in Aria, including past topics', () => {
  expect(startedByAria(sessions[2]!, sessions)).toBe(true)
  expect(startedByAria({ ...sessions[2]!, parentSessionId: 'worker' }, sessions)).toBe(false)
  expect(
    startedByAria(
      { ...sessions[2]!, createdBy: { kind: 'session', sessionId: 'another' } },
      sessions,
    ),
  ).toBe(false)
})

it('counts each pending user item even when several belong to one session', () => {
  const status = ariaActivity(
    sessions,
    () => undefined,
    (id) => (id === 'worker' ? 3 : id === 'another' ? 1 : 0),
  )
  expect(status).toEqual({ state: 'attention', attention: 4, working: 0 })
})
