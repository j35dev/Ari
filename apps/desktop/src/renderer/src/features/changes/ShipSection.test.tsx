import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShipSection } from './ChangesView'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

describe('ShipSection', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
  })

  it('stages, commits, and pushes in sequence, then offers the PR form', async () => {
    const user = userEvent.setup()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      switch (method) {
        case 'git.add':
        case 'git.commit':
        case 'git.push':
          return { ok: true }
        default:
          throw new Error(`unexpected ${method}`)
      }
    })
    const onShipped = vi.fn()
    render(<ShipSection projectPath={'C:\\repo'} hasChanges onShipped={onShipped} />)

    await user.type(screen.getByLabelText('Commit message'), 'feat: add widget{Enter}')

    await waitFor(() => {
      expect(rpcMocks.invoke.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
        'git.add',
        'git.commit',
        'git.push',
      ])
    })
    expect(onShipped).toHaveBeenCalledOnce()
    expect(await screen.findByLabelText('Pull request title')).toHaveValue('feat: add widget')
  })

  it('creates the PR and shows the returned URL', async () => {
    const user = userEvent.setup()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'git.createPr') return { ok: true, url: 'https://github.com/o/r/pull/1' }
      return { ok: true }
    })
    render(<ShipSection projectPath={'C:\\repo'} hasChanges onShipped={() => undefined} />)

    await user.type(screen.getByLabelText('Commit message'), 'work')
    await user.click(screen.getByRole('button', { name: 'Commit & push' }))
    await user.click(await screen.findByRole('button', { name: 'Open pull request' }))

    expect(await screen.findByText(/github.com\/o\/r\/pull\/1/)).toBeInTheDocument()
    expect(rpcMocks.invoke).toHaveBeenCalledWith('git.createPr', {
      path: 'C:\\repo',
      title: 'work',
    })
  })

  it('reports push failures inline and stays on the commit step', async () => {
    const user = userEvent.setup()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'git.push') return { ok: false, error: 'no upstream' }
      return { ok: true }
    })
    render(<ShipSection projectPath={'C:\\repo'} hasChanges onShipped={() => undefined} />)

    await user.type(screen.getByLabelText('Commit message'), 'work')
    await user.click(screen.getByRole('button', { name: 'Commit & push' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('no upstream')
    expect(screen.queryByLabelText('Pull request title')).not.toBeInTheDocument()
  })

  it('surfaces the gh-missing guidance from PR creation', async () => {
    const user = userEvent.setup()
    rpcMocks.invoke.mockImplementation(async (method: string) => {
      if (method === 'git.createPr')
        return { ok: false, url: null, error: 'the GitHub CLI (gh) is not installed' }
      return { ok: true }
    })
    render(<ShipSection projectPath={'C:\\repo'} hasChanges onShipped={() => undefined} />)

    await user.type(screen.getByLabelText('Commit message'), 'work')
    await user.click(screen.getByRole('button', { name: 'Commit & push' }))
    await user.click(await screen.findByRole('button', { name: 'Open pull request' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/gh.*not installed/)
  })
})
