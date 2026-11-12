import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AriaRow } from './AriaRow'
import { ariaActivity, startedByAria } from './aria-activity'
import type { SessionSummary } from '@ari/contracts/rpc'

const chatActions = { onNewChat: vi.fn() }

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
  const { container } = render(
    <AriaRow selected activity={activity} onOpen={onOpen} {...chatActions} />,
  )
  expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveAttribute('aria-current', 'page')
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'attention')
  expect(screen.getByTitle('1 items need you')).toHaveTextContent('1')
  // Needing the user is the one filled accent badge in the chrome.
  expect(screen.getByTitle('1 items need you')).toHaveClass('bg-accent', 'rounded-full')
  expect(screen.getByRole('button', { name: 'Open Aria' })).toHaveClass('bg-fg/9')
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
      {...chatActions}
    />,
  )
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'idle')
  expect(screen.queryByText('0')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open Aria' })).not.toHaveAttribute('aria-current')
  const working = ariaActivity(sessions, (id) =>
    id === 'worker' ? { phase: 'working', startedAt: 1 } : undefined,
  )
  rerender(<AriaRow selected={false} activity={working} onOpen={() => {}} {...chatActions} />)
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'working')
  expect(screen.getByTitle('1 sessions working')).toHaveTextContent('1')
  // Sessions running is information, not a request: same badge, neutral ink.
  expect(screen.getByTitle('1 sessions working')).toHaveClass('rounded-full')
  expect(screen.getByTitle('1 sessions working')).not.toHaveClass('bg-accent')
  const thinking = ariaActivity(sessions, (id) =>
    id === 'aria' || id === 'worker' ? { phase: 'working', startedAt: 1 } : undefined,
  )
  rerender(<AriaRow selected={false} activity={thinking} onOpen={() => {}} {...chatActions} />)
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'thinking')
})

it('attributes only top-level sessions with a session creator to Aria', () => {
  expect(startedByAria(sessions[2]!)).toBe(true)
  expect(startedByAria({ ...sessions[2]!, parentSessionId: 'worker' })).toBe(false)
  expect(startedByAria({ ...sessions[2]!, createdBy: null })).toBe(false)
})

it('keeps attribution and working counts for a lead whose creating Aria chat was deleted', () => {
  const lead: SessionSummary = sessions[2]!
  const remaining = [lead, sessions[3]!]
  expect(startedByAria(lead)).toBe(true)
  expect(startedByAria({ ...lead, parentSessionId: 'parent' })).toBe(false)
  expect(
    ariaActivity(remaining, (id) =>
      id === lead.id ? { phase: 'working', startedAt: 1 } : undefined,
    ),
  ).toEqual({
    state: 'working',
    attention: 0,
    working: 1,
  })
})

it('counts each pending user item even when several belong to one session', () => {
  const status = ariaActivity(
    sessions,
    () => undefined,
    (id) => (id === 'worker' ? 3 : id === 'another' ? 1 : 0),
  )
  expect(status).toEqual({ state: 'attention', attention: 4, working: 0 })
})

it('offers only New chat and waits for confirmation before resetting Aria', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()
  const onNewChat = vi.fn()
  render(
    <AriaRow
      selected
      activity={ariaActivity(sessions, () => undefined)}
      onOpen={onOpen}
      onNewChat={onNewChat}
    />,
  )
  const actions = screen.getByRole('button', { name: 'Aria actions' })
  expect(actions).toHaveClass(
    'opacity-0',
    'group-hover/aria:opacity-100',
    'focus-visible:opacity-100',
  )
  await user.click(actions)
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  await user.click(screen.getByRole('menuitem', { name: 'New chat' }))
  expect(onNewChat).not.toHaveBeenCalled()
  expect(screen.getByText('Delete Aria chat?')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cancel new Aria chat' }))
  expect(onNewChat).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Open Aria' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Aria actions' }))
  await user.click(screen.getByRole('menuitem', { name: 'New chat' }))
  await user.click(screen.getByRole('button', { name: 'Confirm new Aria chat' }))
  expect(onNewChat).toHaveBeenCalledOnce()
  expect(onOpen).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('opens its New chat action by right-click and dismisses the menu with Escape', async () => {
  const user = userEvent.setup()
  render(
    <AriaRow
      selected={false}
      activity={ariaActivity(sessions, () => undefined)}
      onOpen={() => {}}
      {...chatActions}
    />,
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Aria' }))
  expect(screen.getByRole('menuitem', { name: 'New chat' })).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('menu')).toBeNull()
})
