import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { AriaRow } from './AriaRow'
import { ariaActivity, startedByAria } from './aria-activity'
import type { SessionSummary } from '@ari/contracts/rpc'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
beforeEach(() => invoke.mockReset())

const topicActions = { onNewTopic: vi.fn(), onOpenSession: vi.fn() }

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
    <AriaRow selected activity={activity} onOpen={onOpen} {...topicActions} />,
  )
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
      {...topicActions}
    />,
  )
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'idle')
  expect(screen.queryByText('0')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open Aria' })).not.toHaveAttribute('aria-current')
  const working = ariaActivity(sessions, (id) =>
    id === 'worker' ? { phase: 'working', startedAt: 1 } : undefined,
  )
  rerender(<AriaRow selected={false} activity={working} onOpen={() => {}} {...topicActions} />)
  expect(container.querySelector('svg')).toHaveAttribute('data-aria-state', 'working')
  expect(screen.getByTitle('1 sessions working')).toHaveTextContent('1')
  const thinking = ariaActivity(sessions, (id) =>
    id === 'aria' || id === 'worker' ? { phase: 'working', startedAt: 1 } : undefined,
  )
  rerender(<AriaRow selected={false} activity={thinking} onOpen={() => {}} {...topicActions} />)
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

it('keeps topic actions in the hover menu and opens a chosen past topic', async () => {
  const user = userEvent.setup()
  const onOpen = vi.fn()
  const onNewTopic = vi.fn()
  const onOpenSession = vi.fn()
  invoke.mockResolvedValue([sessions[1]])
  render(
    <AriaRow
      selected
      activity={ariaActivity(sessions, () => undefined)}
      onOpen={onOpen}
      onNewTopic={onNewTopic}
      onOpenSession={onOpenSession}
    />,
  )
  expect(screen.queryByText('New topic')).toBeNull()
  expect(screen.queryByText('Past topics')).toBeNull()
  const actions = screen.getByRole('button', { name: 'Aria actions' })
  expect(actions).toHaveClass(
    'opacity-0',
    'group-hover/aria:opacity-100',
    'focus-visible:opacity-100',
  )
  await user.click(actions)
  expect(actions).toHaveAttribute('aria-expanded', 'true')
  await user.click(screen.getByRole('menuitem', { name: 'New topic' }))
  expect(onNewTopic).toHaveBeenCalledOnce()
  expect(onOpen).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
  await user.click(actions)
  await user.click(screen.getByRole('menuitem', { name: 'Past topics' }))
  expect(invoke).toHaveBeenCalledWith('aria.topics')
  const topic = await screen.findByRole('menuitem', { name: 'Past' })
  expect(topic).toHaveFocus()
  await user.click(topic)
  expect(onOpenSession).toHaveBeenCalledWith('past')
  expect(screen.queryByRole('menu')).toBeNull()
})

it('supports right-click and reports empty topics and list failures in the menu', async () => {
  const user = userEvent.setup()
  invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'))
  render(
    <AriaRow
      selected={false}
      activity={ariaActivity(sessions, () => undefined)}
      onOpen={() => {}}
      {...topicActions}
    />,
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Open Aria' }))
  await user.click(screen.getByRole('menuitem', { name: 'Past topics' }))
  expect(await screen.findByRole('menuitem', { name: 'No past topics' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'Aria actions' }))
  await user.click(screen.getByRole('menuitem', { name: 'Past topics' }))
  expect(
    await screen.findByRole('menuitem', { name: 'Could not load past topics.' }),
  ).toHaveAttribute('aria-disabled', 'true')
})

it('does not reopen dismissed topic menus when loading finishes', async () => {
  const user = userEvent.setup()
  let resolve!: (topics: SessionSummary[]) => void
  invoke.mockReturnValue(
    new Promise<SessionSummary[]>((done) => {
      resolve = done
    }),
  )
  render(
    <AriaRow
      selected={false}
      activity={ariaActivity(sessions, () => undefined)}
      onOpen={() => {}}
      {...topicActions}
    />,
  )
  await user.click(screen.getByRole('button', { name: 'Aria actions' }))
  await user.click(screen.getByRole('menuitem', { name: 'Past topics' }))
  expect(screen.getByRole('menuitem', { name: 'Loading past topics…' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await user.keyboard('{Escape}')
  await act(async () => resolve([sessions[1]!]))
  expect(screen.queryByRole('menu')).toBeNull()
})
