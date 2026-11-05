import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitSummary } from '@ari/contracts/rpc'
import { ToastProvider } from '@ari/ui/toast'
import { WorkspaceCard } from './WorkspaceCard'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const summary: GitSummary = {
  branch: 'feat/login',
  changedFiles: 3,
  upstream: 'origin/feat/login',
  ahead: 1,
  behind: 0,
  hasRemote: true,
  operation: null,
}

function mockRpc(repo: GitSummary | null): void {
  rpcMocks.invoke.mockImplementation(async (method: string) => {
    if (method === 'session.workspace') return { path: 'C:\\repos\\demo' }
    if (method === 'scm.summary')
      return repo === null
        ? { ok: false, error: { message: 'not a repository' } }
        : { ok: true, value: repo }
    if (method === 'scm.status') return { ok: true, value: {} }
    if (method === 'scm.review')
      return {
        ok: true,
        value: {
          files: [
            { path: 'a.ts', additions: 10, deletions: 2 },
            { path: 'b.ts', additions: 5, deletions: 0 },
          ],
        },
      }
    if (method === 'scm.pullRequest') return { ok: true, value: null }
    return undefined
  })
}

function renderCard(props: Partial<Parameters<typeof WorkspaceCard>[0]> = {}) {
  return render(
    <ToastProvider>
      <WorkspaceCard sessionId="sess_1" {...props} />
    </ToastProvider>,
  )
}

describe('WorkspaceCard', () => {
  beforeEach(() => mockRpc(summary))
  afterEach(() => vi.clearAllMocks())

  it('shows the session’s branch and change count as a pill', async () => {
    renderCard()
    const pill = await screen.findByRole('button', { name: 'Workspace' })
    expect(await screen.findByText('feat/login')).toBeInTheDocument()
    expect(pill).toHaveTextContent('3')
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    expect(rpcMocks.invoke).toHaveBeenCalledWith(
      'scm.summary',
      expect.objectContaining({ sessionId: 'sess_1' }),
    )
  })

  it('drops down the folder, branch, next Git step and line totals', async () => {
    const user = userEvent.setup()
    renderCard()
    await screen.findByText('feat/login')
    await user.click(screen.getByRole('button', { name: 'Workspace' }))

    const card = screen.getByRole('region', { name: 'Workspace summary' })
    expect(card).toHaveTextContent('demo')
    expect(card).toHaveTextContent('↑1')
    expect(await screen.findByText('+15')).toBeInTheDocument()
    expect(screen.getByText('−2')).toBeInTheDocument()
  })

  it('reveals the folder, opens the review, and closes on Escape', async () => {
    const user = userEvent.setup()
    const onReview = vi.fn()
    renderCard({ onReview })
    await screen.findByText('feat/login')
    await user.click(screen.getByRole('button', { name: 'Workspace' }))

    await user.click(screen.getByRole('button', { name: 'Open in File Explorer' }))
    expect(rpcMocks.invoke).toHaveBeenCalledWith('shell.revealPath', { path: 'C:\\repos\\demo' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Workspace summary' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Workspace' }))
    await user.click(screen.getByRole('button', { name: /^Review changes/ }))
    expect(onReview).toHaveBeenCalledOnce()
  })

  it('reads nothing while its pane is kept alive off screen', () => {
    renderCard({ active: false })
    expect(rpcMocks.invoke).not.toHaveBeenCalled()
  })

  it('names the folder outside a Git repository', async () => {
    mockRpc(null)
    const user = userEvent.setup()
    renderCard()
    const pill = await screen.findByRole('button', { name: 'Workspace' })
    expect(await screen.findByText('demo')).toBeInTheDocument()
    await user.click(pill)
    expect(screen.getByText('Not a Git repository.')).toBeInTheDocument()
  })
})
