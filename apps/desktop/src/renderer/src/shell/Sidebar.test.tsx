import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import {
  formatRelativeTime,
  SessionsUnderProjects,
  SidebarHeader,
} from './Sidebar'

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

const projects = [
  { id: 'proj-1', name: 'Ari' },
  { id: 'proj-2', name: 'Sketch' },
]

function renderSidebar(
  sessions: SessionSummary[],
  activeSessionId: string | null = null,
  handlers: {
    onTogglePin?: (id: string, pinned: boolean) => void
    onToggleArchive?: (id: string, archived: boolean) => void
  } = {},
): void {
  render(
    <SessionsUnderProjects
      sessions={sessions}
      projects={projects}
      activeSessionId={activeSessionId}
      onSelect={() => {}}
      onRename={() => {}}
      onDelete={() => {}}
      onTogglePin={handlers.onTogglePin ?? (() => {})}
      onToggleArchive={handlers.onToggleArchive ?? (() => {})}
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
  it('renders the search box and Active section', () => {
    renderSidebar([session('a', 1), session('b', 3)])
    expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Session a')).toBeInTheDocument()
    expect(screen.getByText('Session b')).toBeInTheDocument()
  })

  it('keeps the last 24h flat and pushes older sessions under Earlier', async () => {
    renderSidebar([session('fresh', 2), session('stale', 30), session('ancient', 72)])

    // Flat rows exist for everything inside the active window…
    expect(screen.getByText('Session fresh')).toBeInTheDocument()

    // …and Earlier is collapsed until summoned.
    expect(screen.queryByText('Session stale')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /earlier/i }))
    expect(screen.getByText('Session stale')).toBeInTheDocument()
    expect(screen.getByText('Session ancient')).toBeInTheDocument()
  })

  it('auto-expands Earlier when the active session lives there', () => {
    renderSidebar([session('fresh', 2), session('stale', 48)], 'stale')
    expect(screen.getByText('Session stale')).toBeInTheDocument()
  })

  it('shows named-project tags on project sessions', () => {
    renderSidebar([session('p', 1, 'proj-1'), session('adhoc-x', 1)])
    expect(screen.getAllByText('Ari').length).toBeGreaterThan(0)
  })

  it('filters across sections when searching', async () => {
    renderSidebar([session('alpha', 1), session('delta', 40)])
    const input = screen.getByPlaceholderText('Search…')
    const user = userEvent.setup()
    await user.type(input, 'delta')
    expect(screen.getByText('Session delta')).toBeInTheDocument()
    expect(screen.queryByText('Session alpha')).not.toBeInTheDocument()
  })

  it('shows an empty state when no sessions exist', () => {
    renderSidebar([])
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument()
  })

  it('pins a session to the top Pinned shelf and reports the toggle', async () => {
    const onTogglePin = vi.fn()
    const pinned = { ...session('p1', 1), pinned: true }
    renderSidebar([session('a', 2), pinned], null, { onTogglePin })

    expect(screen.getByText('Pinned')).toBeInTheDocument()
    // Order: the pinned row renders before the Active-section row.
    const rows = screen.getAllByText(/Session /)
    expect(rows[0]?.textContent).toBe('Session p1')

    const user = userEvent.setup()
    await user.click(
      screen.getAllByRole('button', { name: 'Unpin session' })[0] as HTMLElement,
    )
    expect(onTogglePin).toHaveBeenCalledWith('p1', false)
  })

  it('archives move out of Active into a collapsed Archived shelf', async () => {
    const onToggleArchive = vi.fn()
    const archived = { ...session('old', 2), archived: true }
    renderSidebar([session('live', 1), archived], null, { onToggleArchive })

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
