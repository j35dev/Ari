import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
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

it('opens a drop-up of live children and navigates on click', async () => {
  const open = vi.fn()
  render(
    <ChildSessionActivity
      onOpen={open}
      sessions={[child('a', 'Audit A'), child('b', 'Audit B')]}
      activityOf={(id) => (id === 'a' ? { phase: 'working', startedAt: 1 } : undefined)}
    />,
  )
  expect(screen.queryByRole('menuitem', { name: /Audit A/ })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Child sessions' }))
  expect(screen.getByRole('menu', { name: 'Child sessions' })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: /Audit A/ })).toHaveTextContent('working')
  await userEvent.click(screen.getByRole('menuitem', { name: /Audit B/ }))
  expect(open).toHaveBeenCalledWith('b')
})
