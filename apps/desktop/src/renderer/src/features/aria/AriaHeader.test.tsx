import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { AriaHeader } from './AriaHeader'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

beforeEach(() => invoke.mockReset())

it('starts a new topic and opens a chosen past topic in the existing header', async () => {
  invoke.mockResolvedValue([
    { id: 'past', title: 'Earlier discussion', projectId: 'helm', messageCount: 1, updatedAt: 1 },
  ])
  const onNewTopic = vi.fn()
  const onOpenSession = vi.fn()
  render(<AriaHeader state="idle" onNewTopic={onNewTopic} onOpenSession={onOpenSession} />)
  await userEvent.click(screen.getByRole('button', { name: 'New topic' }))
  expect(onNewTopic).toHaveBeenCalledOnce()
  await userEvent.click(screen.getByRole('button', { name: 'Past topics' }))
  expect(invoke).toHaveBeenCalledWith('aria.topics')
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Earlier discussion' }))
  expect(onOpenSession).toHaveBeenCalledWith('past')
})

it('shows an empty past-topics menu and reports list failures', async () => {
  invoke.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'))
  render(<AriaHeader state="idle" onNewTopic={() => {}} onOpenSession={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: 'Past topics' }))
  expect(await screen.findByRole('menuitem', { name: 'No past topics' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await userEvent.keyboard('{Escape}')
  await userEvent.click(screen.getByRole('button', { name: 'Past topics' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load past topics')
})
