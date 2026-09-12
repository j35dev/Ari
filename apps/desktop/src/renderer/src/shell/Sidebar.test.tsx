import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { SessionActivity } from '../features/session/session-activity'
import {
  formatRelativeTime,
  SessionsUnderProjects,
  SidebarHeader,
  type SidebarProject,
} from './Sidebar'
import { PROJECT_EXPAND_STORAGE_KEY } from './use-project-expand'
import { SIDEBAR_VIEW_STORAGE_KEY } from './use-sidebar-view'

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
  onNewSession: () => void
  onNewSessionInProject: (id: string) => void
  onImportSessions: (id: string) => void
  onRevealProject: (id: string) => void
  onCloseProject: (id: string) => void
  onRemoveProject: (id: string) => void
  onLocateProject: (id: string) => void
  onMoveProject: (id: string, delta: -1 | 1) => void
  activityOf: (id: string) => SessionActivity | undefined
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
  it('keeps children nested, collapsible and discoverable with ancestor search context', async () => {
    const user = userEvent.setup()
    renderSidebar([
      { ...session('tree-child', 0), parentSessionId: 'tree-root' },
      session('tree-root', 2),
    ])
    const toggle = screen.getByRole('button', { name: /children of Session tree-root/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText(/child sessions/i)).not.toBeInTheDocument()
    expect(document.querySelector('svg.lucide-git-branch')).not.toBeNull()
    expect(document.querySelector('[data-session-role="parent"]')).not.toBeNull()
    expect(document.querySelector('[data-session-role="child"]')).not.toBeNull()
    expect(document.querySelector('[data-tree-guides]')).not.toBeNull()
    expect(document.querySelector('[data-session-role="parent"]')?.textContent).toContain('1')
    await user.click(toggle)
    expect(screen.queryByText('Session tree-child')).not.toBeInTheDocument()
    await user.click(toggle)
    expect(screen.getByText('Session tree-child')).toBeInTheDocument()
  })
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

  it('shows context carets on project groups and a dashed one on Unfiled', () => {
    renderSidebar([session('a', 1, 'proj-1'), session('loose', 1)])

    const ari = screen.getByRole('region', { name: 'Ari' })
    expect(ari.querySelector('[data-context-mark="project"]')).not.toBeNull()
    expect(ari.querySelector('[data-iris-tile]')).toBeNull()
    const unfiled = screen.getByRole('region', { name: 'Unfiled' })
    expect(unfiled.querySelector('[data-context-mark="unfiled"]')).not.toBeNull()
    expect(unfiled.querySelector('[data-iris-tile]')).toBeNull()
  })

  it('keeps project names in sentence case', () => {
    renderSidebar([session('a', 1, 'proj-1')])
    const toggle = within(screen.getByRole('region', { name: 'Ari' })).getByRole('button', {
      expanded: true,
    })
    expect(toggle.className).not.toMatch(/uppercase/)
    expect(toggle).toHaveTextContent('Ari')
  })

  it('fills the active group caret and chips the active session row, no plate', () => {
    renderSidebar([session('a', 1, 'proj-1')], 'a')
    const ari = screen.getByRole('region', { name: 'Ari' })
    // The semantic hook survives; the hue plate it used to trigger is gone.
    expect(ari.querySelector('[data-active-group]')).not.toBeNull()
    // The active session row keeps its accent chip…
    const row = ari.querySelector('[data-session-mark="idle"]')?.closest('button')
    expect(row).not.toBeNull()
    expect(row?.className).toMatch(/bg-accent/)
    // …and the project header caret fills with the accent.
    const caret = ari.querySelector('[data-context-mark="project"][data-active]')
    expect(caret).not.toBeNull()
  })

  it('shows a neutral idle dot on session rows', () => {
    renderSidebar([session('a', 1, 'proj-1')])
    const ari = screen.getByRole('region', { name: 'Ari' })
    expect(ari.querySelector('[data-session-mark="idle"]')).not.toBeNull()
    expect(ari.querySelector('svg.lucide-message-square-text')).toBeNull()
  })

  it('surfaces the Working mark on a group header while a session in it runs', () => {
    const now = Date.now()
    renderSidebar([session('a', 1, 'proj-1')], null, {
      activityOf: (id) => (id === 'a' ? { phase: 'working', startedAt: now } : undefined),
    })
    const ari = screen.getByRole('region', { name: 'Ari' })
    const header = within(ari).getByRole('button', { expanded: true })
    expect(within(header).getByRole('status', { name: 'Working' })).toBeInTheDocument()
  })

  it('shows an archived context caret on the Archived shelf header', async () => {
    const archived = { ...session('old', 2, 'proj-1'), archived: true }
    renderSidebar([session('live', 1, 'proj-1'), archived])
    const user = userEvent.setup()
    const shelf = screen.getByRole('button', { name: /archived/i })
    expect(shelf.querySelector('[data-context-mark="archived"]')).not.toBeNull()
    await user.click(shelf)
    expect(screen.getByText('Session old')).toBeInTheDocument()
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

  it('promotes Add project to a full-width button in the compose row', async () => {
    const onOpenProject = vi.fn()
    renderSidebar([], null, { onOpenProject })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect(onOpenProject).toHaveBeenCalledOnce()
  })

  it('hands the new-session picker the rect of the button that opened it', async () => {
    const onNewSession = vi.fn()
    renderSidebar([], null, { onNewSession })
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: 'New session' })
    // jsdom lays nothing out, so give the button a rect to anchor against.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(12, 40, 200, 32))

    await user.click(trigger)

    // The menu hangs just below the button, not at the pointer.
    expect(onNewSession).toHaveBeenCalledWith({ x: 12, y: 76 })
  })

  it('switches to a flat recency list in the Sessions view and persists the choice', async () => {
    renderSidebar([
      session('fresh', 0, 'proj-1'),
      session('stale', 3 * 24, 'proj-2'),
      { ...session('pinned', 30 * 24), pinned: true },
    ])
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Projects', pressed: true })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sessions', pressed: false }))
    expect(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)).toBe('sessions')
    expect(screen.queryByRole('region', { name: 'Ari' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Unfiled' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Pinned' })).toHaveTextContent('Session pinned')
    expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Session fresh')
    expect(screen.getByRole('region', { name: 'Previous 7 days' })).toHaveTextContent(
      'Session stale',
    )
    // Origin survives as a tooltip so a flat row still says where it lives.
    expect(screen.getByText('Session fresh').closest('button')).toHaveAttribute('title', 'Ari')

    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(screen.getByRole('region', { name: 'Ari' })).toBeInTheDocument()
  })

  it('restores the persisted Sessions view and keeps the archived shelf there', async () => {
    localStorage.clear()
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, 'sessions')
    render(
      <SessionsUnderProjects
        sessions={[session('live', 0, 'proj-1'), { ...session('old', 2, 'proj-1'), archived: true }]}
        projects={projects}
        activeSessionId={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
        onToggleArchive={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Sessions', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Session live')
    expect(screen.queryByText('Session old')).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /archived/i }))
    expect(screen.getByText('Session old')).toBeInTheDocument()
  })

  it('re-buckets the Sessions view after midnight without new session data', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2026, 8, 8, 23, 30))
      renderSidebar([session('late', 0, 'proj-1')])
      fireEvent.click(screen.getByRole('button', { name: 'Sessions' }))
      expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Session late')

      vi.setSystemTime(new Date(2026, 8, 9, 0, 1))
      act(() => {
        vi.advanceTimersByTime(61_000)
      })
      expect(screen.queryByRole('region', { name: 'Today' })).not.toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Yesterday' })).toHaveTextContent('Session late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still switches views when localStorage writes fail', async () => {
    const user = userEvent.setup()
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation((): void => {
        throw new Error('quota')
      })
    try {
      renderSidebar([session('fresh', 0, 'proj-1')])
      await user.click(screen.getByRole('button', { name: 'Sessions' }))
      expect(screen.getByRole('button', { name: 'Sessions', pressed: true })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Today' })).toHaveTextContent('Session fresh')
    } finally {
      setItem.mockRestore()
    }
    // A later successful write clears the in-memory override for other tests.
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)).toBe('projects')
  })

  it('fills the archived caret while the active session sits on the shelf', () => {
    renderSidebar([{ ...session('old', 2, 'proj-1'), archived: true }], 'old')
    const shelf = screen.getByRole('button', { name: /archived/i })
    expect(shelf.querySelector('[data-context-mark="archived"][data-active]')).not.toBeNull()
  })

  it('leaves the archived caret neutral when nothing archived is active', () => {
    renderSidebar([{ ...session('old', 2, 'proj-1'), archived: true }], null)
    const shelf = screen.getByRole('button', { name: /archived/i })
    expect(shelf.querySelector('[data-context-mark="archived"]')).not.toBeNull()
    expect(shelf.querySelector('[data-context-mark="archived"][data-active]')).toBeNull()
  })

  it('fires new-session from the labeled compose row', async () => {
    const onNewSession = vi.fn()
    renderSidebar([], null, { onNewSession })
    const user = userEvent.setup()
    const action = screen.getByRole('button', { name: 'New session' })
    expect(action).toHaveAttribute('title', 'New session (Mod+N)')
    expect(action.querySelector('svg.lucide-square-pen')).not.toBeNull()
    await user.click(action)
    expect(onNewSession).toHaveBeenCalledOnce()
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

  it('exposes per-project actions through the right-click menu', async () => {
    const onNewSessionInProject = vi.fn()
    const onImportSessions = vi.fn()
    const onRevealProject = vi.fn()
    const onCloseProject = vi.fn()
    renderSidebar([session('a', 1, 'proj-1')], null, {
      onNewSessionInProject,
      onImportSessions,
      onRevealProject,
      onCloseProject,
    })
    const user = userEvent.setup()

    // Rows carry no inline action buttons any more — everything is in the menu.
    expect(screen.queryByRole('button', { name: 'New session in Ari' })).not.toBeInTheDocument()

    const openMenu = async (): Promise<HTMLElement> => {
      await user.pointer({
        keys: '[MouseRight]',
        target: screen.getByRole('button', { name: 'Ari1' }),
      })
      return screen.getByRole('menu', { name: 'Project actions for Ari' })
    }

    await user.click(within(await openMenu()).getByRole('menuitem', { name: 'New session here' }))
    expect(onNewSessionInProject).toHaveBeenCalledWith('proj-1')

    await user.click(within(await openMenu()).getByRole('menuitem', { name: 'Import' }))
    expect(onImportSessions).toHaveBeenCalledWith('proj-1')

    await user.click(
      within(await openMenu()).getByRole('menuitem', { name: 'Reveal in file manager' }),
    )
    expect(onRevealProject).toHaveBeenCalledWith('proj-1')

    await user.click(within(await openMenu()).getByRole('menuitem', { name: 'Close project' }))
    expect(onCloseProject).toHaveBeenCalledWith('proj-1')
  })

  it('nudges a project one slot from the menu, refused at the edges', async () => {
    const onMoveProject = vi.fn()
    renderSidebar([session('a', 1, 'proj-1')], null, { onMoveProject })
    const user = userEvent.setup()

    const openMenu = async (projectName: string): Promise<HTMLElement> => {
      await user.pointer({
        keys: '[MouseRight]',
        target: screen.getByRole('button', { name: new RegExp(`^${projectName}\\d$`) }),
      })
      return screen.getByRole('menu', { name: `Project actions for ${projectName}` })
    }

    // Ari is the top project: Move up is refused, Move down reports +1.
    const ariMenu = await openMenu('Ari')
    expect(within(ariMenu).getByRole('menuitem', { name: /^Move up/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(within(await openMenu('Ari')).getByRole('menuitem', { name: 'Move down' }))
    expect(onMoveProject).toHaveBeenCalledWith('proj-1', 1)

    // Sketch is last: Move down is refused, Move up reports -1.
    const sketchMenu = await openMenu('Sketch')
    expect(within(sketchMenu).getByRole('menuitem', { name: /^Move down/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(within(await openMenu('Sketch')).getByRole('menuitem', { name: 'Move up' }))
    expect(onMoveProject).toHaveBeenCalledWith('proj-2', -1)
  })

  it('keeps Import discoverable but disabled for a missing project', async () => {
    const onImportSessions = vi.fn()
    renderSidebar([], null, { onImportSessions }, [
      { id: 'gone', name: 'Ghost', path: '/nope', status: 'missing' },
    ])
    const user = userEvent.setup()

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Ghost0' }),
    })
    const importItem = screen.getByRole('menuitem', { name: /Import: Locate this project/ })
    expect(importItem).toHaveAttribute('aria-disabled', 'true')
    await user.click(importItem)
    expect(onImportSessions).not.toHaveBeenCalled()
  })

  it('opens the same menu from the hover affordance, which is not nested inside the row button', async () => {
    const onTogglePin = vi.fn()
    renderSidebar([session('a', 1, 'proj-1')], null, { onTogglePin })
    const user = userEvent.setup()

    // A control nested inside a <button> is invalid HTML and breaks keyboard
    // semantics; the affordance must be a sibling of the row button.
    const affordance = screen.getByRole('button', { name: 'Session actions for Session a' })
    expect(affordance.parentElement?.tagName).not.toBe('BUTTON')

    await user.click(affordance)
    await user.click(screen.getByRole('menuitem', { name: 'Pin to top' }))
    expect(onTogglePin).toHaveBeenCalledWith('a', true)
  })

  it('confirms before removing a project', async () => {
    const onRemoveProject = vi.fn()
    renderSidebar([session('a', 1, 'proj-1')], null, { onRemoveProject })
    const user = userEvent.setup()

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Ari1' }),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Remove project' }))
    expect(onRemoveProject).not.toHaveBeenCalled()
    expect(screen.getByText('Remove project?')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm remove Ari' }))
    expect(onRemoveProject).toHaveBeenCalledWith('proj-1')
  })

  it('insets a project banner off the header and the rows below it', async () => {
    const user = userEvent.setup()
    renderSidebar([session('a', 1, 'proj-1')], 'a', {}, [{ ...projects[0]!, status: 'missing' }])

    // A banner hangs under the header and directly above the session list. Run
    // edge to edge and flush, its rounded corners meet the active row's
    // highlight and the two read as one connected shape, so it keeps an inset
    // on the sides and a gap underneath. Both banners share the rule.
    const missing = screen.getByText('folder missing').parentElement
    expect(missing?.className).toMatch(/\bmx-2\b/)
    expect(missing?.className).toMatch(/\bmb-1\b/)

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Ari1' }),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Remove project' }))

    const confirm = screen.getByText('Remove project?').parentElement
    expect(confirm?.className).toMatch(/\bmx-2\b/)
    expect(confirm?.className).toMatch(/\bmb-1\b/)
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
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Session p1') })
    await user.click(screen.getByRole('menuitem', { name: 'Unpin' }))
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
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Session old') })
    await user.click(screen.getByRole('menuitem', { name: 'Unarchive' }))
    expect(onToggleArchive).toHaveBeenCalledWith('old', false)
  })

  it('shows working / paused / done marks on the live session and its project', () => {
    const now = Date.now()
    const activityOf = (id: string): SessionActivity | undefined => {
      if (id === 'a') return { phase: 'working', startedAt: now }
      if (id === 'b') return { phase: 'paused', startedAt: now, pauseReason: 'approval' }
      if (id === 'c') return { phase: 'done', startedAt: null, settledAt: now }
      return undefined
    }
    renderSidebar(
      [session('a', 1, 'proj-1'), session('b', 2, 'proj-1'), session('c', 1, 'proj-2')],
      null,
      { activityOf },
    )

    const ari = screen.getByRole('region', { name: 'Ari' })
    const sketch = screen.getByRole('region', { name: 'Sketch' })
    expect(within(ari).getAllByRole('status', { name: 'Working' }).length).toBeGreaterThanOrEqual(1)
    expect(within(ari).getByRole('status', { name: 'Waiting for you' })).toBeInTheDocument()
    expect(
      within(sketch).getAllByRole('status', { name: 'Turn complete' }).length,
    ).toBeGreaterThanOrEqual(1)
  })
})

describe('SidebarHeader', () => {
  it('keeps the wordmark quiet and focuses search from the header action', async () => {
    const onSearch = vi.fn()
    render(<SidebarHeader onSearch={onSearch} />)
    const user = userEvent.setup()

    expect(screen.getByLabelText('Ari')).toHaveTextContent('Ari.')
    await user.click(screen.getByRole('button', { name: 'Search sessions' }))
    expect(onSearch).toHaveBeenCalledOnce()
  })

  it('keeps collapse as a separate compact action', async () => {
    const onCollapse = vi.fn()
    render(<SidebarHeader onCollapse={onCollapse} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(onCollapse).toHaveBeenCalledOnce()
  })
})
