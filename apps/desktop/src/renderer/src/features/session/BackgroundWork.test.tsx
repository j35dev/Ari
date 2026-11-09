import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import type { BackgroundTask } from '@ari/contracts/background-task'
import { BackgroundWork, backgroundSummary } from './BackgroundWork'

const task = (overrides: Partial<BackgroundTask> & Pick<BackgroundTask, 'id'>): BackgroundTask => ({
  kind: 'subagent',
  label: 'Survey the repo',
  status: 'running',
  detail: null,
  startedAt: 1_000,
  updatedAt: 1_000,
  endedAt: null,
  ...overrides,
})

it('summarises what runs, and nothing when nothing does', () => {
  const agent = task({ id: 'a' })
  const shell = task({ id: 's', kind: 'shell', label: 'npm test' })
  expect(backgroundSummary([agent, task({ id: 'b' })], false)).toBe('2 agents working')
  expect(backgroundSummary([shell], false)).toBe('Background shell running')
  expect(backgroundSummary([agent, shell], false)).toBe('1 agent working · 1 shell')
  expect(backgroundSummary([{ ...agent, status: 'completed' }], false)).toBeNull()
  expect(backgroundSummary([], true)).toBe('Working in background')
})

it('stays hidden until something runs in the background', () => {
  const { rerender } = render(
    <BackgroundWork tasks={[task({ id: 'a', status: 'completed', endedAt: 2_000 })]} />,
  )
  expect(screen.queryByRole('button', { name: 'Background work' })).not.toBeInTheDocument()
  rerender(<BackgroundWork tasks={[task({ id: 'a' })]} />)
  expect(screen.getByRole('button', { name: 'Background work' })).toHaveTextContent(
    '1 agent working',
  )
})

it('lists running and recently finished work with status, activity and timing', async () => {
  render(
    <BackgroundWork
      since={500}
      tasks={[
        task({
          id: 'old',
          label: 'From an earlier turn',
          status: 'completed',
          startedAt: 100,
          endedAt: 200,
        }),
        task({ id: 'a', detail: 'Read src/a.ts' }),
        task({ id: 's', kind: 'shell', label: 'npm run dev', startedAt: 900 }),
        task({
          id: 'done',
          label: 'Write docs',
          status: 'completed',
          startedAt: 600,
          endedAt: 66_600,
        }),
      ]}
    />,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Background work' }))
  const list = screen.getByRole('list', { name: 'Background work' })
  const rows = within(list).getAllByRole('listitem')
  expect(rows).toHaveLength(3)
  expect(rows[0]).toHaveTextContent('Survey the repo')
  expect(rows[0]).toHaveTextContent('▸ Read src/a.ts')
  expect(rows[0]).toHaveTextContent('working')
  // A shell's end is rarely reported, so it is described by when it started.
  expect(rows[1]).toHaveTextContent('npm run dev')
  expect(rows[1]).toHaveTextContent('Started in background')
  expect(rows[1]).toHaveTextContent('in background')
  expect(rows[2]).toHaveTextContent('Write docs')
  expect(rows[2]).toHaveTextContent('done')
  expect(rows[2]).toHaveTextContent('1m 06s')
  expect(list).not.toHaveTextContent('From an earlier turn')
})

it('says the agent is reporting back while its output arrives between turns', () => {
  render(<BackgroundWork tasks={[]} reporting />)
  const rail = screen.getByRole('button', { name: 'Background work' })
  expect(rail).toHaveTextContent('Working in background')
  expect(rail).toBeDisabled()
})

it('identifies Claude as the owner of its native agents', () => {
  render(<BackgroundWork providerLabel="Claude" tasks={[task({ id: 'a' }), task({ id: 'b' })]} />)
  expect(screen.getByRole('button', { name: 'Background work' })).toHaveTextContent(
    'Claude · 2 agents working',
  )
})
