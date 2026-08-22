import { render, screen, waitFor } from '@testing-library/react'
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

describe('ProjectsView', () => {
  beforeEach(() => {
    invokeFn.mockReset()
  })

  it('renders a card per registered project from project.list', async () => {
    invokeFn.mockResolvedValueOnce(SEED_PROJECTS)
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
    const user = userEvent.setup()
    invokeFn
      .mockResolvedValueOnce(SEED_PROJECTS)
      .mockResolvedValueOnce({ id: ADDED_PROJECT.id, name: ADDED_PROJECT.name, path: ADDED_PATH })
      .mockResolvedValueOnce([...SEED_PROJECTS, ADDED_PROJECT])
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
    expect(invokeFn).toHaveBeenCalledTimes(3)
  })

  it('remove asks for inline confirmation, then calls project.remove', async () => {
    const user = userEvent.setup()
    invokeFn
      .mockResolvedValueOnce([SEED_PROJECTS[0]])
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValueOnce([])
    render(<ProjectsView />)

    await screen.findByText('Ari')
    await user.click(screen.getByRole('button', { name: 'Remove Ari' }))
    expect(screen.getByText('Remove?')).toBeInTheDocument()
    expect(invokeFn).not.toHaveBeenCalledWith('project.remove', expect.anything())

    await user.click(screen.getByRole('button', { name: 'Confirm remove Ari' }))

    await waitFor(() => {
      expect(invokeFn).toHaveBeenCalledWith('project.remove', { id: 'proj_1' })
    })
    expect(
      await screen.findByText('No projects yet.', { exact: false }),
    ).toBeInTheDocument()
  })
})
