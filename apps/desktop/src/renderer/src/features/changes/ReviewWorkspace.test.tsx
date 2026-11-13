import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { ReviewWorkspace, type ReviewView } from './ReviewWorkspace'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('../diffs/DiffSurface', () => ({
  DiffSurface: ({ diffText }: { diffText: string }) => <pre>{diffText}</pre>,
}))
vi.mock('./ChangeRequests', () => ({
  ChangeRequests: () => <p data-testid="requests">Requests</p>,
}))

const snapshot = 'a'.repeat(64)
const file = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  contentId: `${path.charCodeAt(0).toString(16)}`.padEnd(64, '0'),
  kind: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  staged: false,
  unstaged: true,
  ...extra,
})
const two = [file('a.ts'), file('b.ts')]
const many = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((path) => file(path))
let files = two
let turns: { turnId: string; stable: boolean }[] = []
let diff: (path: string) => Promise<unknown> = async (path) => ({
  ok: true,
  value: `${path}:patch`,
})
let review: () => Promise<unknown> = async () => ({
  ok: true,
  value: {
    id: snapshot,
    reviewScopeId: 'b'.repeat(64),
    comparison: { kind: 'working-tree' },
    files,
    baseLabel: 'HEAD',
    headLabel: 'Working tree',
    live: true,
    truncated: false,
  },
})
beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  files = two
  turns = []
  diff = async (path) => ({ ok: true, value: `${path}:patch` })
  review = async () => ({
    ok: true,
    value: {
      id: snapshot,
      reviewScopeId: 'b'.repeat(64),
      comparison: { kind: 'working-tree' },
      files,
      baseLabel: 'HEAD',
      headLabel: 'Working tree',
      live: true,
      truncated: false,
    },
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method: string, params: { path?: string }) => {
    if (method === 'settings.get')
      return { sourceControl: { diffView: 'unified', wrapDiffLines: false } }
    if (method === 'scm.status')
      return {
        ok: true,
        value: {
          status: { branch: 'feature/review', files, remotes: [] },
          refs: ['main'],
          commits: [],
          stashes: [],
          turns,
        },
      }
    if (method === 'scm.review') return review()
    if (method === 'scm.diff') return diff(params.path!)
    if (method === 'scm.mutate') return { ok: true, value: { message: 'Done.' } }
    if (method === 'command.dispatch') return { accepted: true }
    if (method === 'session.load') return { messages: [] }
    return { cancelled: true }
  })
})
afterEach(() => vi.restoreAllMocks())

const diffCalls = () => mocks.invoke.mock.calls.filter(([method]) => method === 'scm.diff')
const header = (path: string) =>
  screen
    .getAllByRole('button', { name: path })
    .find((button) => button.hasAttribute('aria-expanded'))!

function Harness({ initial = 'changes' }: { initial?: ReviewView }) {
  const [view, setView] = useState<ReviewView>(initial)
  return <ReviewWorkspace scope={{ sessionId: 's' }} view={view} onViewChange={setView} />
}

describe('ReviewWorkspace', () => {
  it('asks for a project or session when there is no scope', () => {
    render(<ReviewWorkspace scope={null} />)
    expect(screen.getByText('Open a project or session to see its changes.')).toBeInTheDocument()
  })

  it('shows a stack-shaped skeleton while the first read is in flight', () => {
    review = () => new Promise(() => undefined)
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    expect(screen.getByRole('status', { name: 'Loading changes' })).toBeInTheDocument()
  })

  it('opens every file of a small review and totals it in the header', async () => {
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    expect(await screen.findByText('a.ts:patch')).toBeInTheDocument()
    expect(await screen.findByText('b.ts:patch')).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('−2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review scope: Working tree' })).toHaveAttribute(
      'title',
      'HEAD → Working tree',
    )
  })

  it('opens only the first of many files and loads each patch when its file opens', async () => {
    files = many
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    expect(await screen.findByText('a.ts:patch')).toBeInTheDocument()
    expect(diffCalls()).toHaveLength(1)
    expect(header('b.ts')).toHaveAttribute('aria-expanded', 'false')
    await user.click(header('b.ts'))
    expect(await screen.findByText('b.ts:patch')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scm.diff',
      expect.objectContaining({ projectId: 'p', snapshotId: snapshot, path: 'b.ts', context: 3 }),
    )
    await user.click(header('b.ts'))
    expect(header('b.ts')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('b.ts:patch')).not.toBeInTheDocument()
    // Reopening reads the cached patch instead of asking again.
    await user.click(header('b.ts'))
    expect(await screen.findByText('b.ts:patch')).toBeInTheDocument()
    expect(diffCalls()).toHaveLength(2)
  })

  it('cancels a patch that is still loading when its file closes', async () => {
    files = many
    diff = async (path) =>
      path === 'b.ts' ? new Promise(() => undefined) : { ok: true, value: `${path}:patch` }
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:patch')
    await user.click(header('b.ts'))
    expect(screen.getByRole('status', { name: 'Loading b.ts' })).toBeInTheDocument()
    await user.click(header('b.ts'))
    expect(mocks.invoke).toHaveBeenCalledWith('scm.cancel', expect.anything())
  })

  it('keeps a failed file retryable instead of showing a clean state', async () => {
    let attempts = 0
    files = [file('a.ts')]
    diff = async () =>
      ++attempts === 1
        ? { ok: false, error: { message: 'File exceeds the review limit' } }
        : { ok: true, value: 'retried patch' }
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('File exceeds the review limit')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('retried patch')).toBeInTheDocument()
  })

  it('switches scope from the menu, including to pull requests and back', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText('a.ts:patch')
    await user.click(screen.getByRole('button', { name: 'Review scope: Working tree' }))
    expect(screen.getByRole('menu', { name: 'Review scope' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Working tree/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.click(screen.getByRole('menuitemradio', { name: 'Staged' }))
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scm.review',
      expect.objectContaining({ comparison: { kind: 'staged' } }),
    )
    expect(screen.getByRole('button', { name: 'Review scope: Staged' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Review scope: Staged' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Pull requests' }))
    expect(screen.getByTestId('requests')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Split view' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Review scope: Pull requests' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'This session' }))
    expect(screen.queryByTestId('requests')).not.toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scm.review',
      expect.objectContaining({ comparison: { kind: 'session' } }),
    )
  })

  it('keeps pull requests disabled with their reason where they are unavailable', async () => {
    const user = userEvent.setup()
    render(
      <ReviewWorkspace
        scope={{ projectId: 'p' }}
        administrationReason="Pull requests are unavailable on remote machines."
      />,
    )
    await screen.findByText('a.ts:patch')
    await user.click(screen.getByRole('button', { name: 'Review scope: Working tree' }))
    const item = screen.getByRole('menuitemradio', { name: 'Pull requests' })
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', 'Pull requests are unavailable on remote machines.')
  })

  it('stages a file and discards it after confirmation, from its header', async () => {
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:patch')
    await user.click(screen.getByRole('button', { name: 'Stage a.ts' }))
    expect(mocks.invoke).toHaveBeenCalledWith('scm.mutate', {
      projectId: 'p',
      action: { kind: 'stage', snapshotId: snapshot, paths: ['a.ts'] },
    })
    await user.click(screen.getByRole('button', { name: 'Discard changes in a.ts' }))
    expect(screen.getByText(/recovery checkpoint first/)).toBeInTheDocument()
    expect(
      mocks.invoke.mock.calls.filter(
        ([method, params]) => method === 'scm.mutate' && params.action.kind === 'discard',
      ),
    ).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('scm.mutate', {
        projectId: 'p',
        action: { kind: 'discard', snapshotId: snapshot, paths: ['a.ts'], confirmed: true },
      }),
    )
  })

  it('offers no file actions for a comparison that cannot change files', async () => {
    review = async () => ({
      ok: true,
      value: {
        id: snapshot,
        comparison: { kind: 'session' },
        files,
        baseLabel: 'Session start',
        headLabel: 'Session changes',
        live: true,
        truncated: false,
      },
    })
    render(<ReviewWorkspace scope={{ sessionId: 's' }} initialComparison={{ kind: 'session' }} />)
    await screen.findByText('a.ts:patch')
    expect(screen.queryByRole('button', { name: 'Stage a.ts' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Discard changes/ })).not.toBeInTheDocument()
  })

  it('reverts to before the turn under review from the header', async () => {
    turns = [{ turnId: 't1', stable: true }]
    const user = userEvent.setup()
    render(
      <ToastProvider>
        <ReviewWorkspace
          scope={{ sessionId: 's' }}
          initialComparison={{ kind: 'turn', turnId: 't1' }}
        />
      </ToastProvider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Revert to before this turn' }))
    expect(screen.getByText('Revert to before Turn 1?')).toBeInTheDocument()
    expect(mocks.invoke).not.toHaveBeenCalledWith('command.dispatch', expect.anything())
    await user.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith('command.dispatch', {
        command: { type: 'checkpoint.revert', sessionId: 's', turnId: 't1' },
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review scope: Working tree' }),
      ).toBeInTheDocument(),
    )
  })

  it('lists turns newest first in the scope menu', async () => {
    turns = [
      { turnId: 't1', stable: true },
      { turnId: 't2', stable: false },
    ]
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ sessionId: 's' }} />)
    await screen.findByText('a.ts:patch')
    await user.click(screen.getByRole('button', { name: 'Review scope: Working tree' }))
    const group = screen.getByRole('group', { name: 'Turns' })
    const items = within(group).getAllByRole('menuitemradio')
    expect(items.map((item) => item.textContent)).toEqual(['Turn 2unavailable', 'Turn 1'])
    expect(items[0]).toBeDisabled()
    expect(mocks.invoke).toHaveBeenCalledWith('session.load', { sessionId: 's' })
  })

  it('says a clean working tree is clean and offers the session view', async () => {
    files = []
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ sessionId: 's' }} />)
    expect(await screen.findByText('Working tree is clean.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: "Show this session's changes" }))
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scm.review',
      expect.objectContaining({ comparison: { kind: 'session' } }),
    )
  })

  it('names a turn with no net changes', async () => {
    files = []
    turns = [{ turnId: 't1', stable: true }]
    render(
      <ToastProvider>
        <ReviewWorkspace
          scope={{ sessionId: 's' }}
          initialComparison={{ kind: 'turn', turnId: 't1' }}
        />
      </ToastProvider>,
    )
    expect(await screen.findByText('No changes in this turn.')).toBeInTheDocument()
  })

  it('opens and reveals a file picked in the file tree', async () => {
    files = many
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:patch')
    await user.click(screen.getByRole('button', { name: 'File tree' }))
    const tree = screen.getByRole('navigation', { name: 'Changed files' })
    expect(screen.getByRole('textbox', { name: 'Filter changed files' })).toBeInTheDocument()
    await user.click(within(tree).getByRole('button', { name: 'f.ts' }))
    expect(header('f.ts')).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('f.ts:patch')).toBeInTheDocument()
  })

  it('shows the comparison error as one retryable row', async () => {
    review = async () => ({ ok: false, error: { code: 'failed', message: 'Git is busy.' } })
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Git is busy.')
    review = async () => ({
      ok: true,
      value: {
        id: snapshot,
        comparison: { kind: 'working-tree' },
        files,
        baseLabel: 'HEAD',
        headLabel: 'Working tree',
        live: true,
        truncated: false,
      },
    })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('a.ts:patch')).toBeInTheDocument()
  })
})
