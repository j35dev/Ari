import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import type { SessionActivity } from '../session/session-activity'
import { AriaOverview, ariaOverview } from './AriaOverview'

type Row = Parameters<typeof ariaOverview>[0][number]

let clock = 1_000
function session(id: string, patch: Partial<Row> = {}): Row {
  clock += 1_000
  return {
    id,
    title: id,
    projectId: 'p1',
    archived: false,
    updatedAt: clock,
    parentSessionId: null,
    // Aria is the only thing that creates a top-level session from a session.
    createdBy: { kind: 'session', sessionId: 'aria' },
    ...patch,
  } as Row
}

const activity = (map: Record<string, SessionActivity>) => (id: string) => map[id]

describe('ariaOverview', () => {
  it('covers what Aria started and everything delegated below it, and nothing else', () => {
    const sessions = [
      session('lead'),
      session('worker', { parentSessionId: 'lead', createdBy: undefined }),
      session('mine', { createdBy: undefined }),
      session('aria', { projectId: HELM_PROJECT_ID, createdBy: undefined }),
      session('old', { archived: true }),
    ]
    const groups = ariaOverview(sessions, () => undefined)
    const ids = Object.values(groups)
      .flat()
      .map((item) => item.session.id)
    expect(ids.sort()).toEqual(['lead', 'worker'])
  })

  it('puts what needs the user first, then running work, then results', () => {
    const sessions = [session('asks'), session('runs'), session('done'), session('failed')]
    const groups = ariaOverview(
      sessions,
      activity({
        asks: { phase: 'paused', startedAt: 1, pauseReason: 'input' },
        runs: { phase: 'working', startedAt: 1 },
        done: { phase: 'done', startedAt: null },
        failed: { phase: 'error', startedAt: null },
      }),
    )
    expect(groups.needsYou.map((item) => item.session.id)).toEqual(['asks'])
    expect(groups.needsYou[0]?.detail).toBe('Waiting for your answer')
    expect(groups.working.map((item) => item.session.id)).toEqual(['runs'])
    expect(groups.finished.map((item) => item.session.id).sort()).toEqual(['done', 'failed'])
    expect(groups.recent).toEqual([])
  })

  it('counts an unanswered request as needing the user even after the turn settled', () => {
    const groups = ariaOverview(
      [session('quiet')],
      () => undefined,
      () => 2,
    )
    expect(groups.needsYou[0]?.detail).toBe('2 things need you')
  })

  it('keeps only the newest few idle sessions', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => session(`s${String(index)}`))
    const groups = ariaOverview(sessions, () => undefined)
    expect(groups.recent.map((item) => item.session.id)).toEqual(['s7', 's6', 's5', 's4', 's3'])
  })
})

describe('AriaOverview', () => {
  it('lists sessions under what they need and opens the one chosen', async () => {
    const onOpen = vi.fn()
    const user = userEvent.setup()
    render(
      <AriaOverview
        sessions={[session('Random HTML site'), session('test lead')]}
        activityOf={activity({
          'Random HTML site': { phase: 'paused', startedAt: 1, pauseReason: 'approval' },
          'test lead': { phase: 'working', startedAt: 1 },
        })}
        projectNameOf={() => 'test'}
        onOpen={onOpen}
      />,
    )

    const needsYou = screen.getByRole('region', { name: 'Needs you' })
    expect(within(needsYou).getByText('Waiting for your approval')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Working' })).getByText('test lead'),
    ).toBeInTheDocument()

    await user.click(within(needsYou).getByRole('button', { name: /Random HTML site/ }))
    expect(onOpen).toHaveBeenCalledWith('Random HTML site')
  })

  it('says so when Aria is not leading anything', () => {
    render(
      <AriaOverview
        sessions={[]}
        activityOf={() => undefined}
        projectNameOf={() => null}
        onOpen={() => undefined}
      />,
    )
    expect(screen.getByText('Nothing running')).toBeInTheDocument()
  })
})
