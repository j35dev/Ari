import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import {
  formatRelativeTime,
  SessionsUnderProjects,
  SidebarHeader,
  type SidebarProject,
} from './Sidebar'
import { PROJECT_EXPAND_STORAGE_KEY } from './use-project-expand'

const HOUR = 60 * 60 * 1000

function session(id: string, ageHours: number, projectId = 'adhoc'): SessionSummary {
  return {
    id,
    projectId,
    title: `Session ${id}`,
    updatedAt: Date.now() - ageHours * HOUR,
    messageCount: 2,
  }
}

const projects: SidebarProject[] = [
  { id: 'proj-1', name: 'Ari', path: '/code/ari', status: 'ok' },
  { id: 'proj-2', name: 'Sketch', path: '/code/sketch', status: 'ok' },
]

type Handlers = Partial<{
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleArchive: (id: string, archived: boolean) => void
  onOpenProject: () => void
  onNewSessionInProject: (id: string) => void
  onRevealProject: (id: string) => void
  onCloseProject: (id: string) => void
  onRemoveProject: (id: string) => void
  onLocateProject: (id: string) => void
}>

function renderSidebar(
  sessions: SessionSummary[],
  activeSessionId: string | null = null,
  handlers: Handlers = {},
  openProjects: SidebarProject[] = projects,
): void {
  localStorage.clear()
  render(
    <SessionsUnderProjects
      sessions={sessions}
      projects={openProjects}
      activeSessionId={activeSessionId}
      onSelect={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onTogglePin={handlers.onTogglePin ?? (() => {})}
      onToggleArchive={handlers.onToggleArchive ?? (() => {})}
      {...handlers}
    />,
  )
}

describe('formatRelativeTime', () => {
  it('compacts recency into now/m/h/d/date buckets', () => {
    const now = Date.now()
    expect(formatRelativeTime(now - 30_000, now)).toBe('now')
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m')
    expect(formatRelativeTime(now - 3 * HOUR, now)).toBe('3h')
    expect(formatRelativeTime(now - 2 * 24 * HOUR, now)).toBe('2d')
    expect(formatRelativeTime(now - 9 * 24 * HOUR, now)).not.toMatch(/^[0-9]+[mhd]$/)
  })
})

describe('SessionsUnderProjects', () => {
  it('nests sessions under each open project group', () => {
    renderSidebar([session('a', 1, 'proj-1'), session('b', 3, 'proj-2')])

    const ari = screen.getByRole('region', { name: 'Ari' })
    const sketch = screen.getByRole('region', { name: 'Sketch' })
    expect(ari).toHaveTextContent('Session a')
    expect(ari).not.toHaveTextContent('Session b')
    expect(sketch).toHaveTextContent('Session b')
  })

  it('puts adhoc sessions in a trailing Unfiled group', () => {
    renderSidebar([session('filed', 1, 'proj-1'), session('loose', 1)])

    const unfiled = screen.getByRole('region', { name: 'Unfiled' })
    expect(unfiled).toHaveTextContent('Session loose')
    expect(unfiled).not.toHaveTextContent('Session filed')

    // Unfiled renders last, after every project group.
    const groups = screen.getAllByRole('region')
    expect(groups.at(-1)).toBe(unfiled)
  })

  it('omits the Unfiled group when nothing is unfiled', () => {
    renderSidebar([session('a', 1, 'proj-1')])
    expect(screen.queryByRole('region', { name: 'Unfiled' })).not.toBeInTheDocument()
  })

  it('shows each group session count', () => {
    renderSidebar([session('a', 1, 'proj-1'), session('b', 2, 'proj-1')])
    expect(screen.getByRole('region', { name: 'Ari' })).toHaveTextContent('2')
  })

  it('floats pinned sessions to the top inside their own group', () => {
    const pinned = { ...session('p1', 40, 'proj-2'), pinned: true }
    renderSidebar([session('a', 2, 'proj-1'), session('fresh', 1, 'proj-2'), pinned])

    const sketch = screen.getByRole('region', { name: 'Sketch' })
    const titles = Array.from(sketch.querySelectorAll('li')).map((li) => li.textContent)
    expect(titles[0]).toContain('Session p1')
    // Pinning is scoped to the group: it never jumps above another project.
    expect(screen.getByRole('region', { name: 'Ari' })).toHaveTextContent('Session a')
  })

  it('collapses and re-expands a project group', async () => {
    renderSidebar([session('a', 1, 'proj-1')])
    const user = userEvent.setup()
    const toggle = screen.getAllByRole('button', { expanded: true })[0] as HTMLElement

    await user.click(toggle)
    expect(screen.queryByText('Session a')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByText('Session a')).toBeInTheDocument()
  })

  it('honours persisted collapse state per project', () => {
    localStorage.clear()
    localStorage.setItem(PROJECT_EXPAND_STORAGE_KEY, JSON.stringify({ 'proj-1': false }))
    render(
      <SessionsUnderProjects
        sessions={[session('a', 1, 'proj-1'), session('b', 1, 'proj-2')]}
        projects={projects}
        activeSessionId={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
        onToggleArchive={() => {}}
      />,
    )
    expect(screen.queryByText('Session a')).not.toBeInTheDocument()
    expect(screen.getByText('Session b')).toBeInTheDocument()
  })

  it('offers Open project and reports the click', async () => {
    const onOpenProject = vi.fn()
    renderSidebar([], null, { onOpenProject })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open project' }))
    expect(onOpenProject).toHaveBeenCalledOnce()
  })

  it('renders a missing project muted with Locate and Close, keeping its sessions', async () => {
    const onLocateProject = vi.fn()
    const onCloseProject = vi.fn()
    renderSidebar([session('a', 1, 'gone')], null, { onLocateProject, onCloseProject }, [
      { id: 'gone', name: 'Ghost', path: '/nope', status: 'missing' },
    ])

    const group = screen.getByRole('region', { name: 'Ghost' })
    expect(group).toHaveTextContent('folder missing')
    // Session loading is unaffected by the degraded folder.
    expect(group).toHaveTextContent('Session a')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Locate' }))
    expect(onLocateProject).toHaveBeenCalledWith('gone')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onCloseProject).toHaveBeenCalledWith('gone')
  })

  it('exposes per-project new-session, reveal and close actions', async () => {
    const onNewSessionInProject = vi.fn()
    const onRevealProject = vi.fn()
    const onCloseProject = vi.fn()
    renderSidebar([session('a', 1, 'proj-1')], null, {
      onNewSessionInProject,
      onRevealProject,
      onCloseProject,
    })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'New session in Ari' }))
    expect(onNewSessionInProject).toHaveBeenCalledWith('proj-1')
    await user.click(screen.getByRole('button', { name: 'Reveal Ari' }))
    expect(onRevealProject).toHaveBeenCalledWith('proj-1')
    await user.click(screen.getByRole('button', { name: 'Close Ari' }))
    expect(onCloseProject).toHaveBeenCalledWith('proj-1')
  })

  it('confirms before removing a project', async () => {
    const onRemoveProject = vi.fn()
    renderSidebar([session('a', 1, 'proj-1')], null, { onRemoveProject })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Remove Ari' }))
    expect(onRemoveProject).not.toHaveBeenCalled()
    expect(screen.getByText('Remove project?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm remove Ari' }))
    expect(onRemoveProject).toHaveBeenCalledWith('proj-1')
  })

  it('flattens search matches across every project', async () => {
    renderSidebar([
      session('alpha', 1, 'proj-1'),
      session('alpha-two', 2, 'proj-2'),
      session('delta', 3),
    ])
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('Search…'), 'alpha')

    // Matches leave their groups entirely and land in one flat list.
    expect(screen.queryByRole('region', { name: 'Ari' })).not.toBeInTheDocument()
    expect(screen.getByText('Session alpha')).toBeInTheDocument()
    expect(screen.getByText('Session alpha-two')).toBeInTheDocument()
    expect(screen.queryByText('Session delta')).not.toBeInTheDocument()
  })

  it('shows an empty state when no sessions exist', () => {
    renderSidebar([], null, {}, [])
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument()
  })

  it('reports the pin toggle from a grouped row', async () => {
    const onTogglePin = vi.fn()
    const pinned = { ...session('p1', 1, 'proj-1'), pinned: true }
    renderSidebar([pinned], null, { onTogglePin })

    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: 'Unpin session' })[0] as HTMLElement)
    expect(onTogglePin).toHaveBeenCalledWith('p1', false)
  })

  it('keeps archived sessions out of the groups and in a global shelf', async () => {
    const onToggleArchive = vi.fn()
    const archived = { ...session('old', 2, 'proj-1'), archived: true }
    renderSidebar([session('live', 1, 'proj-1'), archived], null, { onToggleArchive })

    expect(screen.queryByText('Session old')).not.toBeInTheDocument()
    expect(screen.getByText('Session live')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /archived/i }))
    expect(screen.getByText('Session old')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Unarchive session' }))
    expect(onToggleArchive).toHaveBeenCalledWith('old', false)
  })
})

describe('SidebarHeader', () => {
  it('fires new-session from the + affordance', async () => {
    const onNewSession = vi.fn()
    render(<SidebarHeader onNewSession={onNewSession} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'New session' }))
    expect(onNewSession).toHaveBeenCalledOnce()
  })
})
