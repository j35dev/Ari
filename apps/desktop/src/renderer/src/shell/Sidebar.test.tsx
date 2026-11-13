import { fireEvent, render, screen, within } from '@testing-library/react'
import { resetSessionOrderCache } from '../features/session/session-order'
import { SESSION_MIME } from '../features/split/drag-split'
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

function session(
  id: string,
  ageHours: number,
  projectId = 'adhoc',
  flags: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    projectId,
    title: `Session ${id}`,
    updatedAt: Date.now() - ageHours * HOUR,
    messageCount: 2,
    ...flags,
  }
}

const projects: SidebarProject[] = [
  { id: 'proj-1', name: 'Ari', path: '/code/ari', status: 'ok' },
  { id: 'proj-2', name: 'Sketch', path: '/code/sketch', status: 'ok' },
]

it('hides Aria project groups and threads from the sidebar and its search', async () => {
  renderSidebar([session('helm-topic', 0, 'helm'), session('normal', 1, 'proj-1')], null, {}, [
    { id: 'helm', name: 'Aria', path: '/aria', status: 'ok' },
    ...projects,
  ])
  expect(screen.queryByText('Aria')).toBeNull()
  expect(screen.queryByText('Session helm-topic')).toBeNull()
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'helm-topic')
  expect(screen.queryByText('Session helm-topic')).toBeNull()
})

type Handlers = Partial<{
  onTogglePin: (id: string, pinned: boolean) => void
  onToggleArchive: (id: string, archived: boolean) => void
  onDelete: (id: string) => void
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
      onDelete={handlers.onDelete ?? (() => {})}
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
    const parent = document.querySelector('[data-session-role="parent"]') as HTMLElement
    expect(parent).not.toBeNull()
    expect(document.querySelector('[data-session-role="child"]')).not.toBeNull()
    // The tree line hangs off the child, not the parent.
    expect(parent.querySelector('[data-tree-guides]')).toBeNull()
    expect(document.querySelector('[data-session-role="child"] [data-tree-guides]')).not.toBeNull()
    // The child count is always in the tree, but only drawn once the children
    // are folded away: listed underneath, they speak for themselves.
    expect(parent.textContent).toContain('1')
    expect(within(parent).getByText('1')).toHaveClass('sr-only')
    await user.click(toggle)
    expect(screen.queryByText('Session tree-child')).not.toBeInTheDocument()
    expect(within(parent).getByText('1')).not.toHaveClass('sr-only')
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

  it('shows each group session count once the group is folded', async () => {
    renderSidebar([session('a', 1, 'proj-1'), session('b', 3, 'proj-1')])
    const ari = screen.getByRole('region', { name: 'Ari' })
    const header = within(ari).getByRole('button', { expanded: true })
    // Open, the rows are the count; it stays in the header's name for
    // assistive tech without being drawn.
    expect(header).toHaveAccessibleName('Ari2')
    expect(within(header).getByText('2')).toHaveClass('sr-only')
    await userEvent.setup().click(header)
    expect(within(header).getByText('2')).not.toHaveClass('sr-only')
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

  it('marks the active group folder and washes the active session row, no accent', () => {
    renderSidebar([session('a', 1, 'proj-1'), session('b', 2, 'proj-1')], 'a')
    const ari = screen.getByRole('region', { name: 'Ari' })
    // The semantic hook survives; the hue plate it used to trigger is gone.
    expect(ari.querySelector('[data-active-group]')).not.toBeNull()
    // The active session row takes the selection wash, not an accent chip…
    const row = within(ari).getByText('Session a').closest('button')
    expect(row).toHaveClass('bg-fg/9', 'text-fg!')
    expect(row?.className).not.toMatch(/bg-accent/)
    expect(within(ari).getByText('Session b').closest('button')).not.toHaveClass('bg-fg/9')
    // …and the project's folder is flagged as holding it: open, and no initial.
    const mark = ari.querySelector('[data-context-mark="project"][data-active]')
    expect(mark).not.toBeNull()
    expect(mark).toHaveAttribute('data-open')
    expect(mark).toHaveTextContent('')
  })

  it('closes a project folder when the project is collapsed', async () => {
    const user = userEvent.setup()
    renderSidebar([session('a', 1, 'proj-1')])
    const ari = screen.getByRole('region', { name: 'Ari' })
    const mark = () => ari.querySelector('[data-context-mark="project"]')
    expect(mark()).toHaveAttribute('data-open')

    await user.click(within(ari).getByRole('button', { expanded: true }))
    expect(mark()).not.toHaveAttribute('data-open')
  })

  it('shows the age, not a mark, in the status slot of an idle session row', () => {
    renderSidebar([session('a', 1, 'proj-1')])
    const ari = screen.getByRole('region', { name: 'Ari' })
    const row = within(ari).getByText('Session a').closest('button') as HTMLElement
    expect(within(row).getByText('1h')).toBeInTheDocument()
    expect(within(row).queryByRole('status')).not.toBeInTheDocument()
    expect(row.querySelector('svg')).toBeNull()
  })

  it('swaps the age for the status glyph while a session has something to say', () => {
    const now = Date.now()
    renderSidebar([session('a', 1, 'proj-1'), session('b', 2, 'proj-1')], null, {
      activityOf: (id) =>
        id === 'a'
          ? { phase: 'paused', startedAt: now, pauseReason: 'approval' }
          : id === 'b'
            ? { phase: 'working', startedAt: now }
            : undefined,
    })
    const ari = screen.getByRole('region', { name: 'Ari' })
    const waiting = within(ari).getByText('Session a').closest('button') as HTMLElement
    const glyph = within(waiting).getByRole('status', { name: 'Waiting for you' })
    expect(glyph).toHaveClass('ari-status')
    expect(glyph).toHaveAttribute('data-status', 'attention')
    expect(within(waiting).queryByText('1h')).not.toBeInTheDocument()
    // No status words on a compact row: the glyph and its label carry it.
    expect(waiting).not.toHaveTextContent(/Approval|Waiting|Working/)
    const running = within(ari).getByText('Session b').closest('button') as HTMLElement
    expect(running.querySelectorAll('.ari-forge-cell')).toHaveLength(8)
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

  it.each(['approval', 'input'] as const)(
    'keeps a %s decision visible in a collapsed project with running and queued sessions',
    async (pauseReason) => {
      renderSidebar(
        [
          session('run', 0, 'proj-1'),
          session('queue', 1, 'proj-1'),
          session('blocked', 2, 'proj-1'),
        ],
        null,
        {
          activityOf: (id) =>
            id === 'run'
              ? { phase: 'working', startedAt: Date.now() }
              : id === 'queue'
                ? { phase: 'queued', startedAt: null }
                : { phase: 'paused', startedAt: Date.now(), pauseReason },
        },
      )
      const project = screen.getByRole('region', { name: 'Ari' })
      const header = within(project).getByRole('button', { expanded: true })
      await userEvent.setup().click(header)
      expect(header).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Session blocked')).not.toBeInTheDocument()
      expect(within(header).getByRole('status', { name: 'Waiting for you' })).toBeInTheDocument()
      expect(within(header).queryByRole('status', { name: 'Working' })).not.toBeInTheDocument()
      expect(within(header).queryByRole('status', { name: 'Queued' })).not.toBeInTheDocument()
    },
  )

  it('shows a queued session card without an execution timer', async () => {
    renderSidebar([session('queue', 0, 'proj-1')], null, {
      activityOf: () => ({ phase: 'queued', startedAt: null }),
    })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sessions' }))
    const card = screen.getByText('Session queue').closest('button') as HTMLElement
    expect(within(card).getByRole('status', { name: 'Queued' })).toBeInTheDocument()
    expect(within(card).getByText('Queued')).toBeInTheDocument()
    expect(within(card).getByText('Queued').querySelector('.tabular-nums')).toBeNull()
    expect(card.querySelector('.ari-forge-cell')).toBeNull()
  })

  it('folds queued child activity through collapsed child and project groups as it starts', async () => {
    localStorage.clear()
    const sessions = [
      session('root', 0, 'proj-1'),
      session('child', 1, 'proj-1', { parentSessionId: 'root' }),
    ]
    const view = (activity: SessionActivity) => (
      <SessionsUnderProjects
        sessions={sessions}
        projects={projects}
        activeSessionId={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
        onToggleArchive={() => {}}
        activityOf={(id) => (id === 'child' ? activity : undefined)}
      />
    )
    const { rerender } = render(view({ phase: 'queued', startedAt: null }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /children of Session root/i }))
    expect(screen.queryByText('Session child')).not.toBeInTheDocument()
    const root = screen.getByText('Session root').closest('button') as HTMLElement
    expect(within(root).getByRole('status', { name: 'Queued' })).toBeInTheDocument()
    const header = within(screen.getByRole('region', { name: 'Ari' })).getByRole('button', {
      expanded: true,
    })
    await user.click(header)
    expect(within(header).getByRole('status', { name: 'Queued' })).toBeInTheDocument()
    rerender(view({ phase: 'working', startedAt: Date.now() }))
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(within(header).getByRole('status', { name: 'Working' })).toBeInTheDocument()
    rerender(view({ phase: 'paused', startedAt: Date.now(), pauseReason: 'input' }))
    expect(within(header).getByRole('status', { name: 'Waiting for you' })).toBeInTheDocument()
  })

  it('shows an archived context caret on the Archived shelf header', async () => {
    const archived = { ...session('old', 2, 'proj-1'), archived: true }
    renderSidebar([session('live', 1, 'proj-1'), archived])
    const user = userEvent.setup()
    const shelf = screen.getByRole('button', { name: 'Archived' })
    expect(shelf.querySelector('[data-context-mark="archived"]')).not.toBeNull()
    expect(shelf).toHaveAttribute('aria-expanded', 'false')
    await user.click(shelf)
    expect(shelf).toHaveAttribute('aria-expanded', 'true')
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

  it('keeps Add project as an icon action beside the view switch', async () => {
    const onOpenProject = vi.fn()
    renderSidebar([], null, { onOpenProject })
    const user = userEvent.setup()
    const add = screen.getByRole('button', { name: 'Add project' })
    expect(add.querySelector('svg.lucide-plus')).not.toBeNull()
    expect(add.parentElement).toContainElement(screen.getByRole('group', { name: 'Sidebar view' }))
    await user.click(add)
    expect(onOpenProject).toHaveBeenCalledOnce()
  })

  it('keeps Add project reachable while a search hides the view switch', async () => {
    const onOpenProject = vi.fn()
    renderSidebar([session('alpha', 1, 'proj-1')], null, { onOpenProject })
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('Search…'), 'alpha')
    expect(screen.queryByRole('group', { name: 'Sidebar view' })).not.toBeInTheDocument()
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

  it('switches to a flat Sessions list and persists the choice', async () => {
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
    const active = screen.getByRole('region', { name: 'Active' })
    expect(active).toHaveTextContent('Session fresh')
    expect(active).toHaveTextContent('Session stale')
    expect(screen.queryByRole('region', { name: 'Today' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Previous 7 days' })).not.toBeInTheDocument()
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
        sessions={[
          session('live', 0, 'proj-1'),
          { ...session('old', 2, 'proj-1'), archived: true },
        ]}
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
    expect(screen.getByRole('region', { name: 'Active' })).toHaveTextContent('Session live')
    expect(screen.queryByText('Session old')).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Archived' }))
    expect(screen.getByText('Session old')).toBeInTheDocument()
  })

  it('rearranges Sessions cards by dragging one onto another, and keeps the order', () => {
    localStorage.clear()
    resetSessionOrderCache()
    localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, 'sessions')
    const list = [session('a', 0, 'proj-1'), session('b', 1, 'proj-1'), session('c', 2, 'proj-1')]
    const props = {
      projects,
      activeSessionId: null,
      onSelect: () => {},
      onRename: () => {},
      onDelete: () => {},
      onTogglePin: () => {},
      onToggleArchive: () => {},
    }
    const { rerender } = render(<SessionsUnderProjects {...props} sessions={list} />)
    const order = () =>
      within(screen.getByRole('region', { name: 'Active' }))
        .getAllByRole('listitem')
        .map((item) => /Session (\w)/.exec(item.textContent ?? '')?.[1])
    expect(order()).toEqual(['a', 'b', 'c'])
    const card = (id: string) =>
      within(screen.getByRole('region', { name: 'Active' }))
        .getAllByRole('listitem')
        .find((item) => item.textContent?.includes(`Session ${id}`))!
    const dataTransfer = {
      types: [SESSION_MIME],
      dropEffect: 'none',
      effectAllowed: 'move',
      setData: () => {},
      getData: () => 'a',
      setDragImage: () => {},
    }
    // Drag the newest card below the oldest (jsdom boxes are empty, so the drop
    // lands in the lower half: "after").
    fireEvent.dragStart(within(card('a')).getAllByRole('button')[0]!, { dataTransfer })
    fireEvent.dragOver(card('c'), { dataTransfer })
    expect(card('c').querySelector('[data-drop-indicator="after"]')).not.toBeNull()
    fireEvent.drop(card('c'), { dataTransfer })
    expect(order()).toEqual(['b', 'c', 'a'])
    // New activity on `a` would make it newest again; the arrangement holds.
    rerender(
      <SessionsUnderProjects
        {...props}
        sessions={[{ ...session('a', 0, 'proj-1'), updatedAt: Date.now() + 1000 }, list[1]!, list[2]!]}
      />,
    )
    expect(order()).toEqual(['b', 'c', 'a'])
  })

  it('renders inbox cards with project, status, branch and provider', async () => {
    const user = userEvent.setup()
    renderSidebar(
      [
        session('card', 0, 'proj-1', {
          branch: 'feat/session-inbox',
          driverKind: 'claude',
        }),
      ],
      null,
      {
        activityOf: (id) =>
          id === 'card'
            ? { phase: 'paused', startedAt: Date.now(), pauseReason: 'approval' }
            : undefined,
      },
    )
    await user.click(screen.getByRole('button', { name: 'Sessions' }))

    const active = screen.getByRole('region', { name: 'Active' })
    expect(active).toHaveTextContent('Ari')
    expect(active).toHaveTextContent('Session card')
    expect(active).toHaveTextContent('Approval')
    expect(active).toHaveTextContent('feat/session-inbox')
    expect(within(active).getByRole('status', { name: 'Waiting for you' })).toBeInTheDocument()
    expect(within(active).getByTitle('Claude')).toBeInTheDocument()
  })

  it('says where a session card lives and when, then gives the title its own line', async () => {
    const user = userEvent.setup()
    renderSidebar([session('card', 0, 'proj-1', { branch: 'feat/x', driverKind: 'claude' })])
    await user.click(screen.getByRole('button', { name: 'Sessions' }))

    const card = screen.getByText('Session card').closest('button') as HTMLElement
    const [first, second] = Array.from(card.children) as HTMLElement[]
    // First line: project, agent, branch and age. Second: the title alone.
    expect(first).toHaveTextContent('Ari')
    expect(first).toHaveTextContent('feat/x')
    expect(within(first!).getByTitle('Claude')).toBeInTheDocument()
    expect(first).not.toHaveTextContent('Session card')
    expect(second).toHaveTextContent('Session card')
    // A card names its project in words; it carries no project mark of its own.
    expect(card.querySelector('[data-context-mark]')).toBeNull()
  })

  it('hides child agents from the Sessions list', async () => {
    const user = userEvent.setup()
    renderSidebar([
      session('root', 0, 'proj-1'),
      { ...session('child', 1, 'proj-1'), parentSessionId: 'root' },
    ])
    await user.click(screen.getByRole('button', { name: 'Sessions' }))

    const active = screen.getByRole('region', { name: 'Active' })
    expect(active).toHaveTextContent('Session root')
    expect(active).toHaveTextContent('Ari')
    expect(active).not.toHaveTextContent('Session child')
    expect(active.querySelector('[data-session-role="child"]')).toBeNull()
    expect(within(active).queryByText('child')).not.toBeInTheDocument()
    expect(within(active).queryByTitle('1 child agent')).not.toBeInTheDocument()
    expect(active.querySelector('[data-tree-guides]')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Collapse children of Session root' }),
    ).not.toBeInTheDocument()
  })

  it('keeps a running thread on the card, with the working mark and no Working shelf', async () => {
    const user = userEvent.setup()
    const now = Date.now()
    renderSidebar([session('run', 0, 'proj-1'), session('idle', 1, 'proj-1')], null, {
      activityOf: (id) => (id === 'run' ? { phase: 'working', startedAt: now } : undefined),
    })
    await user.click(screen.getByRole('button', { name: 'Sessions' }))

    const active = screen.getByRole('region', { name: 'Active' })
    expect(active).toHaveTextContent('Session run')
    expect(active).toHaveTextContent('Session idle')
    expect(active).toHaveTextContent('Ari')
    expect(within(active).getByRole('status', { name: 'Working' })).toBeInTheDocument()
    expect(within(active).queryByText('Working')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Working sessions' })).not.toBeInTheDocument()
  })

  it('animates the parent card while a child agent works, without listing the child', async () => {
    const user = userEvent.setup()
    renderSidebar(
      [session('root', 0, 'proj-1'), { ...session('child', 1, 'proj-1'), parentSessionId: 'root' }],
      null,
      {
        activityOf: (id) =>
          id === 'child' ? { phase: 'working', startedAt: Date.now() } : undefined,
      },
    )
    await user.click(screen.getByRole('button', { name: 'Sessions' }))

    const active = screen.getByRole('region', { name: 'Active' })
    expect(active).toHaveTextContent('Session root')
    expect(active).not.toHaveTextContent('Session child')
    expect(within(active).getByRole('status', { name: 'Working' })).toBeInTheDocument()
  })

  it('still switches views when localStorage writes fail', async () => {
    const user = userEvent.setup()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((): void => {
      throw new Error('quota')
    })
    try {
      renderSidebar([session('fresh', 0, 'proj-1')])
      await user.click(screen.getByRole('button', { name: 'Sessions' }))
      expect(screen.getByRole('button', { name: 'Sessions', pressed: true })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Active' })).toHaveTextContent('Session fresh')
    } finally {
      setItem.mockRestore()
    }
    // A later successful write clears the in-memory override for other tests.
    await user.click(screen.getByRole('button', { name: 'Projects' }))
    expect(localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)).toBe('projects')
  })

  it('fills the archived caret while the active session sits on the shelf', () => {
    renderSidebar([{ ...session('old', 2, 'proj-1'), archived: true }], 'old')
    const shelf = screen.getByRole('button', { name: 'Archived' })
    expect(shelf.querySelector('[data-context-mark="archived"][data-active]')).not.toBeNull()
  })

  it('leaves the archived caret neutral when nothing archived is active', () => {
    renderSidebar([{ ...session('old', 2, 'proj-1'), archived: true }], null)
    const shelf = screen.getByRole('button', { name: 'Archived' })
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

    // The one action worth a press of its own sits on the header beside the
    // menu affordance, as a sibling of the header button, never inside it.
    const quickNew = screen.getByRole('button', { name: 'New session in Ari' })
    expect(quickNew.parentElement?.tagName).not.toBe('BUTTON')
    await user.click(quickNew)
    expect(onNewSessionInProject).toHaveBeenCalledWith('proj-1')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    onNewSessionInProject.mockClear()

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
    await user.click(screen.getByRole('button', { name: 'Archived' }))
    expect(screen.getByText('Session old')).toBeInTheDocument()
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Session old') })
    await user.click(screen.getByRole('menuitem', { name: 'Unarchive' }))
    expect(onToggleArchive).toHaveBeenCalledWith('old', false)
  })

  it('restores every archived session from the shelf menu', async () => {
    const onToggleArchive = vi.fn()
    renderSidebar(
      [
        session('live', 1, 'proj-1'),
        { ...session('old-a', 2, 'proj-1'), archived: true },
        { ...session('old-b', 3, 'proj-2'), archived: true },
      ],
      null,
      { onToggleArchive },
    )
    const user = userEvent.setup()
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Archived' }),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Restore all' }))
    expect(onToggleArchive).toHaveBeenCalledWith('old-a', false)
    expect(onToggleArchive).toHaveBeenCalledWith('old-b', false)
    expect(onToggleArchive).not.toHaveBeenCalledWith('live', false)
  })

  it('confirms before emptying the archive from the shelf menu', async () => {
    const onDelete = vi.fn()
    renderSidebar(
      [
        session('live', 1, 'proj-1'),
        { ...session('old-a', 2, 'proj-1'), archived: true },
        { ...session('old-b', 3, 'proj-2'), archived: true },
      ],
      null,
      { onDelete },
    )
    const user = userEvent.setup()
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('button', { name: 'Archived' }),
    })
    await user.click(screen.getByRole('menuitem', { name: 'Empty archive' }))
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm empty archive' }))
    expect(onDelete).toHaveBeenCalledWith('old-a')
    expect(onDelete).toHaveBeenCalledWith('old-b')
    expect(onDelete).not.toHaveBeenCalledWith('live')
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
    expect(within(ari).getAllByRole('status', { name: 'Waiting for you' })).toHaveLength(2)
    expect(
      within(sketch).getAllByRole('status', { name: 'Turn complete' }).length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('reserves the hover-action width so a long title truncates before the overlay', () => {
    renderSidebar([
      {
        ...session('long', 1, 'proj-1'),
        title: 'Ask me any random questions i am just testing overflow',
      },
    ])
    const time = screen.getByText('1h')
    expect(time.className).toMatch(/\bmin-w-11\b/)
    expect(screen.getByText(/Ask me any random questions/)).toHaveClass('truncate')
  })

  it('archives a live session from the hover affordance without opening the menu', async () => {
    const onToggleArchive = vi.fn()
    renderSidebar([session('live', 1, 'proj-1')], null, { onToggleArchive })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Archive Session live' }))
    expect(onToggleArchive).toHaveBeenCalledWith('live', true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('archives every live session in a project from the group menu', async () => {
    const onToggleArchive = vi.fn()
    renderSidebar(
      [session('a', 1, 'proj-1'), session('b', 2, 'proj-1'), session('c', 1, 'proj-2')],
      null,
      { onToggleArchive },
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Project actions for Ari' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive all in this project' }))
    expect(onToggleArchive).toHaveBeenCalledWith('a', true)
    expect(onToggleArchive).toHaveBeenCalledWith('b', true)
    expect(onToggleArchive).not.toHaveBeenCalledWith('c', true)
  })

  it('confirms before deleting every live session in a project', async () => {
    const onDelete = vi.fn()
    renderSidebar([session('a', 1, 'proj-1'), session('b', 2, 'proj-1')], null, { onDelete })
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Project actions for Ari' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete all in this project' }))
    expect(onDelete).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm delete all in Ari' }))
    expect(onDelete).toHaveBeenCalledWith('a')
    expect(onDelete).toHaveBeenCalledWith('b')
  })

  it('lets the user pick a subset in a project and archive the selection', async () => {
    const onToggleArchive = vi.fn()
    renderSidebar(
      [
        session('keep', 1, 'proj-1'),
        session('drop-a', 2, 'proj-1'),
        session('drop-b', 3, 'proj-1'),
      ],
      null,
      { onToggleArchive },
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Project actions for Ari' }))
    await user.click(screen.getByRole('menuitem', { name: 'Select sessions' }))

    await user.click(screen.getByRole('checkbox', { name: 'Select Session drop-a' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select Session drop-b' }))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive' }))

    expect(onToggleArchive).toHaveBeenCalledWith('drop-a', true)
    expect(onToggleArchive).toHaveBeenCalledWith('drop-b', true)
    expect(onToggleArchive).not.toHaveBeenCalledWith('keep', true)
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument()
  })

  it('selects a range with shift-click and clears on Escape', async () => {
    const onToggleArchive = vi.fn()
    renderSidebar(
      [session('a', 1, 'proj-1'), session('b', 2, 'proj-1'), session('c', 3, 'proj-1')],
      null,
      { onToggleArchive },
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Project actions for Ari' }))
    await user.click(screen.getByRole('menuitem', { name: 'Select sessions' }))

    await user.click(screen.getByRole('checkbox', { name: 'Select Session a' }))
    await user.keyboard('{Shift>}')
    await user.click(screen.getByRole('checkbox', { name: 'Select Session c' }))
    await user.keyboard('{/Shift}')
    expect(screen.getByText('3 selected')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByText('3 selected')).not.toBeInTheDocument()
    expect(onToggleArchive).not.toHaveBeenCalled()
  })

  it('calls the latest handler after a re-render that only replaced handlers', async () => {
    localStorage.clear()
    const sessions = [session('a', 1, 'proj-1')]
    const first = vi.fn()
    const second = vi.fn()
    const view = (onSelect: (id: string) => void) => (
      <SessionsUnderProjects
        sessions={sessions}
        projects={projects}
        activeSessionId={null}
        onSelect={onSelect}
        onRename={() => {}}
        onDelete={() => {}}
        onTogglePin={() => {}}
        onToggleArchive={() => {}}
      />
    )
    const { rerender } = render(view(first))
    rerender(view(second))

    await userEvent.setup().click(screen.getByText('Session a'))

    expect(second).toHaveBeenCalledWith('a')
    expect(first).not.toHaveBeenCalled()
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
