import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import type { SessionSummary } from '@ari/contracts/rpc'
import { NewSessionLauncher } from './NewSessionLauncher'

const projects: Project[] = [
  {
    id: 'proj-ari',
    name: 'Ari',
    path: 'D:\\Projects\\Ari',
    colorIndex: 0,
    createdAt: 1,
    lastOpenedAt: Date.now() - 3_600_000 * 2,
    open: true,
    status: 'ok',
  },
  {
    id: 'proj-mobile',
    name: 'Ari mobile',
    path: 'D:\\Projects\\Ari\\apps\\mobile',
    colorIndex: 1,
    createdAt: 2,
    lastOpenedAt: 0,
    open: true,
    status: 'ok',
  },
  {
    id: 'proj-lost',
    name: 'Lost repo',
    path: 'E:\\gone\\lost-repo',
    colorIndex: 2,
    createdAt: 3,
    lastOpenedAt: 0,
    open: false,
    status: 'missing',
  },
]

const sessions: SessionSummary[] = [
  {
    id: 'sess-1',
    projectId: 'proj-mobile',
    title: 'Fix the picker',
    updatedAt: 0,
    messageCount: 3,
    parentId: null,
    archived: false,
  },
  {
    id: 'sess-2',
    projectId: 'proj-ari',
    title: 'Archived one',
    updatedAt: 0,
    messageCount: 1,
    parentId: null,
    archived: true,
  },
] as unknown as SessionSummary[]

function launch(overrides?: {
  projects?: Project[]
  preferredProjectId?: string | null
  onCreate?: (projectId: string, lead: boolean) => void
  onAddProject?: () => void
}) {
  const onCreate = overrides?.onCreate ?? vi.fn()
  const onAddProject = overrides?.onAddProject ?? vi.fn()
  const onClose = vi.fn()
  render(
    <NewSessionLauncher
      open
      projects={overrides?.projects ?? projects}
      sessions={sessions}
      preferredProjectId={overrides?.preferredProjectId}
      onCreate={onCreate}
      onAddProject={onAddProject}
      onClose={onClose}
    />,
  )
  return { onCreate, onAddProject, onClose }
}

describe('NewSessionLauncher', () => {
  it('lists each project once, with recent candidates first', () => {
    launch()
    const dialog = screen.getByRole('dialog', { name: 'New session' })

    const names = within(dialog).getAllByRole('option').map((row) => row.getAttribute('aria-label'))
    expect(names).toHaveLength(3)
    expect(names).toEqual(['Ari', 'Lost repo', 'Ari mobile'])
    // The duplicated "Lead session in X" rows are gone: exactly one per project.
    expect(within(dialog).getAllByRole('button', { name: /Lead session in/ })).toHaveLength(3)
  })

  it('shows the folder path and live open-session count', () => {
    launch()
    const dialog = screen.getByRole('dialog', { name: 'New session' })
    const ari = within(dialog).getByRole('option', { name: 'Ari' })
    expect(ari.getAttribute('title')).toBe('D:\\Projects\\Ari')
    // Clicks count only non-archived sessions; a project with none shows its
    // last-opened age instead.
    expect(within(ari).getByText('2h ago')).toBeInTheDocument()
    const mobile = within(dialog).getByRole('option', { name: 'Ari mobile' })
    expect(within(mobile).getByText('1 open')).toBeInTheDocument()
    expect(within(mobile).queryByText('2h ago')).not.toBeInTheDocument()
  })

  it('filters rows as the user types', async () => {
    const user = userEvent.setup()
    launch()
    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'mobile')
    const dialog = screen.getByRole('dialog', { name: 'New session' })
    expect(within(dialog).getByRole('option', { name: 'Ari mobile' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('option', { name: /^Ari$/ })).not.toBeInTheDocument()
  })

  it('offers the folder picker when nothing matches', async () => {
    const user = userEvent.setup()
    const { onAddProject } = launch()
    await user.type(screen.getByRole('textbox', { name: 'Search projects' }), 'nowhere')
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pick a folder anyway' }))
    expect(onAddProject).toHaveBeenCalledOnce()
  })

  it('creates the session in the first match on Enter', async () => {
    const user = userEvent.setup()
    const { onCreate, onClose } = launch()
    expect(screen.getByRole('option', { name: 'Ari' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(onCreate).toHaveBeenCalledWith('proj-ari', false)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('walks the visible rows with the arrow keys', async () => {
    const user = userEvent.setup()
    launch()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: 'Lost repo' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('option', { name: 'Ari mobile' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('creates a lead session on Alt+Enter', async () => {
    const user = userEvent.setup()
    const { onCreate } = launch()
    await user.keyboard('{Alt>}{Enter}{/Alt}')
    expect(onCreate).toHaveBeenCalledWith('proj-ari', true)
  })

  it('creates a lead session from the row chip and the mouse pick', async () => {
    const user = userEvent.setup()
    const { onCreate } = launch()
    const dialog = screen.getByRole('dialog', { name: 'New session' })
    await user.click(
      within(within(dialog).getByRole('option', { name: 'Ari mobile' })).getByRole('button', {
        name: 'Lead session in Ari mobile',
      }),
    )
    expect(onCreate).toHaveBeenCalledWith('proj-mobile', true)
  })

  it('closes on Escape without creating anything', async () => {
    const user = userEvent.setup()
    const { onClose, onCreate } = launch()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('ranks the working project first and labels it current', () => {
    launch({ preferredProjectId: 'proj-mobile' })
    const dialog = screen.getByRole('dialog', { name: 'New session' })
    const names = within(dialog).getAllByRole('option').map((row) => row.getAttribute('aria-label'))
    expect(names[0]).toBe('Ari mobile')
    const head = within(dialog).getAllByRole('option')[0]
    expect(head).not.toBeNull()
    expect(within(head as HTMLElement).getByText('current')).toBeInTheDocument()
  })

  it('renders as a centered modal with a dimmed scrim', () => {
    render(
      <NewSessionLauncher
        open
        projects={Array.from({ length: 12 }, (_, i) => ({
          id: `proj-${i}`,
          name: `Project ${i}`,
          path: `D:\\Projects\\p${i}`,
          colorIndex: 0,
          createdAt: i,
          lastOpenedAt: 0,
          open: true,
          status: 'ok' as const,
        }))}
        sessions={[]}
        onCreate={vi.fn()}
        onAddProject={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const dialog = screen.getByRole('dialog', { name: 'New session' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // The scrim covers the app; the list is height-capped so scale happens in
    // the search field, not in an ever-taller column.
    expect(dialog.parentElement?.style.background).toContain('black')
    expect(dialog.querySelector('[role="listbox"]')).toHaveStyle({ maxHeight: '320px' })
  })
})
