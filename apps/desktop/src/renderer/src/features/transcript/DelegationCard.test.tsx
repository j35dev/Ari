import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DelegationCard } from './DelegationCard'
import type { DelegatedChild } from './types'

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

const child = (
  title: string,
  state: DelegatedChild['state'],
  extra: Partial<DelegatedChild> = {},
): DelegatedChild => ({
  sessionId: title,
  title,
  role: null,
  driverKind: 'codex',
  modelId: null,
  state,
  startedAt: null,
  report: null,
  anchor: { messageId: null, partIndex: 0 },
  ...extra,
})

/** The group from the report: a three-day-old lead, removed workers, and today's two. */
const mixed = [
  child('test lead', 'stopped', { settledAt: NOW - 72 * HOUR }),
  child('Random HTML site', 'removed'),
  child('DeepSeek site', 'removed'),
  child('GLM site', 'removed'),
  child('Site: Orbital Garden', 'done', { settledAt: NOW - HOUR / 4 }),
  child('Site: Nocturne Arcade', 'working', { startedAt: NOW - 60_000 }),
]

function mount(children: DelegatedChild[]) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  return render(<DelegationCard row={{ kind: 'delegation', key: 'group', children }} />)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DelegationCard', () => {
  it('counts only running and recent agents in the group row', () => {
    mount(mixed)
    const row = screen.getByRole('button', { name: /2 agents/ })
    expect(row).toHaveTextContent('1 working, 1 result ready')
    expect(row).not.toHaveTextContent('removed')
    expect(row).not.toHaveTextContent('interrupted')
  })

  it('lists the current agents, with the old ones one step further away', async () => {
    const user = userEvent.setup()
    mount(mixed)
    await user.click(screen.getByRole('button', { name: /2 agents/ }))

    const current = screen.getByRole('list', { name: 'Delegated sessions' })
    expect(within(current).getAllByRole('listitem')).toHaveLength(2)
    expect(within(current).getByText('Site: Orbital Garden')).toBeInTheDocument()
    expect(within(current).getByText('Site: Nocturne Arcade')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Earlier delegated sessions' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Show 4 earlier agents' }))
    const earlier = screen.getByRole('list', { name: 'Earlier delegated sessions' })
    expect(within(earlier).getAllByRole('listitem')).toHaveLength(4)
    expect(within(earlier).getByText('test lead')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Hide 4 earlier agents' }))
    expect(screen.queryByRole('list', { name: 'Earlier delegated sessions' })).toBeNull()
  })

  it('shows a lone current agent outright, keeping the earlier ones behind the toggle', () => {
    mount([child('old', 'removed'), child('Only one', 'working', { startedAt: NOW - 1000 })])
    expect(screen.queryByRole('button', { name: /agents/ })).toBeNull()
    expect(screen.getByText('Only one')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Show 1 earlier agent' })).toBeVisible()
  })

  it('offers no earlier toggle when every agent is current', () => {
    mount([child('a', 'working'), child('b', 'done', { settledAt: NOW - HOUR })])
    expect(screen.queryByRole('button', { name: /earlier/ })).toBeNull()
  })

  it('shows what an agent reported as plain words, not markdown source', async () => {
    const user = userEvent.setup()
    mount([
      child('Garden', 'done', {
        settledAt: NOW - HOUR,
        report: '**Report** - **Concept:** *Orbital Garden*',
      }),
      child('Arcade', 'working', { startedAt: NOW - 1000 }),
    ])
    await user.click(screen.getByRole('button', { name: /2 agents/ }))
    expect(screen.getByText('Report - Concept: Orbital Garden')).toBeInTheDocument()
    expect(screen.queryByText(/\*\*/)).toBeNull()
  })

  it('draws one tile per provider in the group row, however many agents share it', () => {
    mount([
      child('a', 'working'),
      child('b', 'working'),
      child('c', 'working', { driverKind: 'claude' }),
    ])
    const row = screen.getByRole('button', { name: /3 agents/ })
    expect(row.querySelectorAll('span.rounded-full')).toHaveLength(2)
  })

  it('gives each state its glyph, including interrupted and removed', async () => {
    const user = userEvent.setup()
    mount(mixed)
    await user.click(screen.getByRole('button', { name: /2 agents/ }))
    await user.click(screen.getByRole('button', { name: 'Show 4 earlier agents' }))
    const glyph = (title: string) =>
      screen
        .getByText(title)
        .closest('li')
        ?.querySelector('.ari-status')
        ?.getAttribute('data-status')
    expect(glyph('Site: Nocturne Arcade')).toBe('working')
    expect(glyph('Site: Orbital Garden')).toBe('done')
    expect(glyph('test lead')).toBe('stopped')
    expect(glyph('GLM site')).toBe('idle')
  })
})
