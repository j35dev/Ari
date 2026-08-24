import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ari/contracts/project'
import { ProjectsView } from './ProjectsView'

const { invokeFn } = vi.hoisted(() => ({ invokeFn: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: vi.fn(() => () => undefined),
  },
}))

const SEED_PROJECTS: Project[] = [
  { id: 'proj_1', name: 'Ari', path: 'C:\\code\\ari', colorIndex: 0, createdAt: 1 },
  { id: 'proj_2', name: 'Website', path: 'C:\\code\\site', colorIndex: 1, createdAt: 2 },
]

const ADDED_PATH = 'D:\\work\\demo'
const ADDED_PROJECT: Project = {
  id: 'proj_3',
  name: 'demo',
  path: ADDED_PATH,
  colorIndex: 2,
  createdAt: 3,
}

/**
 * Method-aware rpc mock: view-level project.list results come from a queue
 * (falling back to SEED_PROJECTS), while per-card scripts/fs lookups answer
 * deterministically regardless of call interleaving.
 */
function installRpc(overrides: {
  listQueue?: Project[][]
  scripts?: { name: string; command: string }[]
  files?: { name: string; type: string; size: number }[]
} = {}): void {
  const listQueue = [...(overrides.listQueue ?? [])]
  const scripts = overrides.scripts ?? []
  const files = overrides.files ?? []
  invokeFn.mockImplementation(async (method: string, params?: unknown) => {
    switch (method) {
      case 'project.list':
        return listQueue.length > 0 ? (listQueue.shift() as Project[]) : SEED_PROJECTS
      case 'project.add':
        if ((params as { path?: string })?.path !== ADDED_PATH) throw new Error('bad path')
        return { id: ADDED_PROJECT.id, name: ADDED_PROJECT.name, path: ADDED_PATH }
      case 'project.remove':
        return { removed: true }
      case 'scripts.list':
        return { scripts }
      case 'fs.list':
        return files
      default:
        throw new Error(`unexpected method: ${String(method)}`)
    }
  })
}

describe('ProjectsView', () => {
  beforeEach(() => {
    invokeFn.mockReset()
  })

  it('renders a card per registered project from project.list', async () => {
    installRpc()
    const { container } = render(<ProjectsView />)

    expect(await screen.findByText('Ari')).toBeInTheDocument()
    expect(screen.getByText('C:\\code\\ari')).toBeInTheDocument()
    expect(screen.getByText('Website')).toBeInTheDocument()
    expect(screen.getByText('C:\\code\\site')).toBeInTheDocument()
    expect(invokeFn).toHaveBeenCalledWith('project.list')

    const chips = container.querySelectorAll('span[aria-hidden="true"]')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveStyle({ filter: 'hue-rotate(0deg)' })
    expect(chips[1]).toHaveStyle({ filter: 'hue-rotate(40deg)' })
  })

  it('add flow submits the entered path to project.add and refreshes', async () => {
    installRpc({ listQueue: [SEED_PROJECTS, [...SEED_PROJECTS, ADDED_PROJECT]] })
    const user = userEvent.setup()
    render(<ProjectsView />)

    await screen.findByText('Ari')
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.type(screen.getByLabelText('Folder path'), ADDED_PATH)
    await user.type(screen.getByLabelText('Name'), 'demo')
    await user.click(screen.getByRole('button', { name: 'Add project' }))

    await waitFor(() => {
      expect(invokeFn).toHaveBeenCalledWith(
        'project.add',
        expect.objectContaining({ path: ADDED_PATH }),
      )
    })
    expect(await screen.findByText(ADDED_PATH)).toBeInTheDocument()
  })

  it('remove asks for inline confirmation, then calls project.remove', async () => {
    installRpc({ listQueue: [[SEED_PROJECTS[0] as Project], []] })
    const user = userEvent.setup()
    render(<ProjectsView />)

    await screen.findByText('Ari')
    await user.click(screen.getByRole('button', { name: 'Remove Ari' }))
    expect(screen.getByText('Remove?')).toBeInTheDocument()
    expect(invokeFn).not.toHaveBeenCalledWith('project.remove', expect.anything())

    await user.click(screen.getByRole('button', { name: 'Confirm remove Ari' }))

    await waitFor(() => {
      expect(invokeFn).toHaveBeenCalledWith('project.remove', { id: 'proj_1' })
    })
    expect(await screen.findByText('No projects yet.', { exact: false })).toBeInTheDocument()
  })

  it('renders script chips and opens the terminal inspector on click', async () => {
    installRpc({
      files: [{ name: 'pnpm-lock.yaml', type: 'file', size: 1 }],
      scripts: [{ name: 'dev', command: 'vite' }],
    })
    const onOpenTerminal = vi.fn()
    const user = userEvent.setup()
    render(<ProjectsView onOpenTerminal={onOpenTerminal} />)

    // Scope to the first card — every card renders its own chip set.
    const ariPath = await screen.findByText('C:\\code\\ari')
    const firstCard = ariPath.closest('li') as HTMLElement
    const chip = await within(firstCard).findByRole('button', { name: 'dev' })
    expect(chip).toHaveAttribute('title', 'pnpm run dev — vite')

    await user.click(chip)
    expect(onOpenTerminal).toHaveBeenCalledOnce()
  })

  it('caps rendered script chips at six per card', async () => {
    installRpc({
      scripts: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, command: `cmd ${i}` })),
    })
    render(<ProjectsView />)

    const firstCard = (
      await screen.findByText('C:\\code\\ari')
    ).closest('li') as HTMLElement
    await waitFor(() => {
      expect(within(firstCard).getAllByRole('button')).toHaveLength(7) // 6 chips + Remove
    })
  })
})
