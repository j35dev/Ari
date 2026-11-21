import { useState } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredProject } from '@ari/contracts/project'
import { OnboardingProjects, lastActive } from './OnboardingProjects'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))

const now = Date.now()
const day = 86_400_000
const repo = (
  name: string,
  daysAgo: number,
  branch: string | null = 'main',
): DiscoveredProject => ({
  path: `/work/${name}`,
  name,
  sources: ['claude'],
  lastUsedAt: now - daysAgo * day,
  branch,
})
let discovered: DiscoveredProject[]
let chosen: DiscoveredProject[] = []
const onContinue = vi.fn()

function Harness() {
  const [selected, setSelected] = useState<DiscoveredProject[]>([])
  chosen = selected
  return (
    <OnboardingProjects
      selected={selected}
      onChange={setSelected}
      onBack={vi.fn()}
      onContinue={onContinue}
      headingRef={() => undefined}
      primaryRef={() => undefined}
    />
  )
}

afterEach(cleanup)
beforeEach(() => {
  onContinue.mockReset()
  discovered = [
    repo('ari', 0),
    repo('scratch', 0, null),
    repo('kollect', 2, 'dev'),
    repo('hop', 5),
    repo('chimp', 15),
  ]
  invoke.mockReset()
  invoke.mockImplementation(async (method, params) => {
    if (method === 'project.discover')
      return { projects: discovered, truncated: false, warnings: [] }
    if (method === 'dialog.pickFolder') return { path: '/elsewhere/picked' }
    if (method === 'project.create')
      return {
        projectId: 'p1',
        name: (params as { name: string }).name,
        path: '/home/me/Projects/new-thing',
        created: true,
      }
    throw new Error(method)
  })
})

describe('onboarding projects', () => {
  it('lists Git folders most recent first with branch and time, ticking the newest three', async () => {
    render(<Harness />)
    const list = await screen.findByRole('list', { name: 'Projects' })
    const rows = within(list).getAllByRole('checkbox')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'ari (/work/ari)',
      'kollect (/work/kollect)',
      'hop (/work/hop)',
      'chimp (/work/chimp)',
    ])
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'true',
      'false',
    ])
    expect(within(rows[1]!).getByText('dev · 2d ago')).toBeInTheDocument()
    expect(within(rows[3]!).getByText('main · 2w ago')).toBeInTheDocument()
    expect(screen.queryByText('scratch')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add 3 projects' })).toBeInTheDocument()
    // Nothing is imported until setup finishes.
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['project.discover'])
  })

  it('lets the user untick everything and skip', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('list', { name: 'Projects' })
    for (const row of screen.getAllByRole('checkbox', { checked: true })) await user.click(row)
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(onContinue).toHaveBeenCalledOnce()
    expect(chosen).toEqual([])
  })

  it('adds a chosen folder ticked', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('list', { name: 'Projects' })
    await user.click(screen.getByRole('button', { name: 'Choose another folder…' }))
    const picked = await screen.findByRole('checkbox', { name: 'picked (/elsewhere/picked)' })
    expect(picked).toHaveAttribute('aria-checked', 'true')
    expect(chosen.map((p) => p.path)).toContain('/elsewhere/picked')
  })

  it('creates a new empty Git project and ticks it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('list', { name: 'Projects' })
    await user.click(screen.getByRole('button', { name: 'Create a new project' }))
    await user.type(screen.getByRole('textbox', { name: 'New project name' }), 'New thing{Enter}')
    expect(invoke).toHaveBeenCalledWith('project.create', { name: 'New thing' })
    const created = await screen.findByRole('checkbox', {
      name: 'New thing (/home/me/Projects/new-thing)',
    })
    expect(created).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('textbox', { name: 'New project name' })).toBeNull()
  })

  it('keeps a failed create recoverable', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method, params) =>
      method === 'project.create'
        ? Promise.reject(new Error('Choose a project folder outside system folders.'))
        : base(method, params),
    )
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('list', { name: 'Projects' })
    await user.click(screen.getByRole('button', { name: 'Create a new project' }))
    await user.type(screen.getByRole('textbox', { name: 'New project name' }), 'x{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('outside system folders')
    expect(screen.getByRole('textbox', { name: 'New project name' })).toHaveValue('x')
  })

  it('falls back to choosing a folder when discovery fails', async () => {
    invoke.mockImplementation(async (method) => {
      if (method === 'project.discover') throw new Error('denied')
      return { path: null }
    })
    render(<Harness />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a folder instead')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled())
  })
})

describe('lastActive', () => {
  it('reads like a person would say it', () => {
    expect(lastActive(now, now)).toBe('today')
    expect(lastActive(now - day, now)).toBe('yesterday')
    expect(lastActive(now - 3 * day, now)).toBe('3d ago')
    expect(lastActive(now - 21 * day, now)).toBe('3w ago')
    expect(lastActive(now - 90 * day, now)).toBe('3mo ago')
    expect(lastActive(null, now)).toBeNull()
  })
})
