import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewWorkspace } from './ReviewWorkspace'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('../diffs/DiffSurface', () => ({
  DiffSurface: ({ diffText }: { diffText: string }) => <pre>{diffText}</pre>,
}))
const files = ['a.ts', 'b.ts'].map((path, index) => ({
  path,
  contentId: String(index + 1).repeat(64),
  kind: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  staged: false,
  unstaged: true,
}))
const context = {
  ok: true,
  value: {
    status: { branch: 'feature/review', files },
    refs: ['main'],
    commits: [],
    stashes: [],
    turns: [],
  },
}
const manifest = {
  ok: true,
  value: {
    id: 'a'.repeat(64),
    reviewScopeId: 'b'.repeat(64),
    files,
    baseLabel: 'HEAD',
    headLabel: 'Working tree',
    live: true,
  },
}
let review = manifest
beforeEach(() => {
  sessionStorage.clear()
  review = manifest
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(900)
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (method, params: { path?: string; context?: number }) =>
    method === 'scm.status'
      ? context
      : method === 'scm.review'
        ? review
        : method === 'scm.diff'
          ? { ok: true, value: `${params.path}:${params.context}` }
          : { cancelled: true },
  )
})
afterEach(() => vi.restoreAllMocks())

describe('ReviewWorkspace', () => {
  it('keeps explicit viewed progress across navigation, remount and changes to another file', async () => {
    const user = userEvent.setup()
    const view = render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:3')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'b.ts' }))
    await screen.findByText('b.ts:3')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    view.unmount()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('b.ts:3')
    expect(screen.getByText('1/2 viewed')).toBeInTheDocument()
    review = {
      ...manifest,
      value: {
        ...manifest.value,
        id: 'c'.repeat(64),
        files: [files[0]!, { ...files[1]!, contentId: '3'.repeat(64) }],
      },
    }
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        'scm.diff',
        expect.objectContaining({ snapshotId: review.value.id }),
      ),
    )
    expect(screen.getByText('1/2 viewed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'a.ts' }))
    await screen.findByText('a.ts:3')
    expect(screen.getByRole('checkbox')).toBeChecked()
    await user.click(screen.getByRole('checkbox'))
    expect(screen.queryByText('1/2 viewed')).not.toBeInTheDocument()
  })

  it('invalidates changed content even when line counts match and does not restore reverted marks', async () => {
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:3')
    await user.click(screen.getByRole('checkbox'))
    review = {
      ...manifest,
      value: {
        ...manifest.value,
        id: 'c'.repeat(64),
        files: [{ ...files[0]!, contentId: '3'.repeat(64) }, files[1]!],
      },
    }
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
    expect(screen.queryByText('1/2 viewed')).not.toBeInTheDocument()
    review = manifest
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText('a.ts:3')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('isolates marks when comparison, resolved base, workspace or project changes', async () => {
    const user = userEvent.setup()
    const view = render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:3')
    await user.click(screen.getByRole('checkbox'))
    review = { ...manifest, value: { ...manifest.value, reviewScopeId: 'c'.repeat(64) } }
    await user.click(screen.getByRole('button', { name: 'Compare changes' }))
    await user.click(screen.getByRole('option', { name: 'Staged' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
    review = manifest
    await user.click(screen.getByRole('button', { name: 'Compare changes' }))
    await user.click(screen.getByRole('option', { name: 'Working tree' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked())
    // The backend scope also changes for a new resolved base or project worktree.
    review = { ...manifest, value: { ...manifest.value, reviewScopeId: 'd'.repeat(64) } }
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked())
    review = manifest
    view.rerender(<ReviewWorkspace scope={{ projectId: 'other' }} />)
    await screen.findByText('a.ts:3')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('drops deleted and renamed paths without carrying viewed status to a replacement', async () => {
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    await screen.findByText('a.ts:3')
    await user.click(screen.getByRole('checkbox'))
    review = {
      ...manifest,
      value: { ...manifest.value, id: 'c'.repeat(64), files: [files[1]!] },
    }
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText('b.ts:3')
    expect(screen.queryByText(/viewed$/)).not.toBeInTheDocument()
    review = manifest
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText('a.ts:3')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    await user.click(screen.getByRole('checkbox'))
    review = {
      ...manifest,
      value: {
        ...manifest.value,
        id: 'd'.repeat(64),
        files: [{ ...files[0]!, path: 'renamed.ts' }, files[1]!],
      },
    }
    await user.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText('renamed.ts:3')
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('loads only the selected file and restores its selection after remount', async () => {
    const user = userEvent.setup()
    const view = render(<ReviewWorkspace scope={{ sessionId: 's' }} />)
    expect(await screen.findByText('a.ts:3')).toBeInTheDocument()
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'scm.diff')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'b.ts' }))
    expect(await screen.findByText('b.ts:3')).toBeInTheDocument()
    view.unmount()
    render(<ReviewWorkspace scope={{ sessionId: 's' }} />)
    expect(await screen.findByText('b.ts:3')).toBeInTheDocument()
  })

  it('offers staged comparisons and expands context without requesting the entire patch', async () => {
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ sessionId: 's' }} />)
    await screen.findByText('a.ts:3')
    await user.click(screen.getByRole('button', { name: 'Expand diff context' }))
    expect(await screen.findByText('a.ts:43')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Compare changes' }))
    await user.click(screen.getByRole('option', { name: 'Staged' }))
    expect(mocks.invoke).toHaveBeenCalledWith(
      'scm.review',
      expect.objectContaining({ comparison: { kind: 'staged' } }),
    )
  })

  it('retains multiple selected files for explicit Git controls', async () => {
    const user = userEvent.setup()
    render(
      <ReviewWorkspace
        scope={{ sessionId: 's' }}
        renderControls={(state) => <p>{state.paths.join(',')}</p>}
      />,
    )
    await screen.findByText('a.ts:3')
    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('button', { name: 'b.ts' }))
    await user.keyboard('{/Control}')
    expect(screen.getByText('a.ts,b.ts')).toBeInTheDocument()
  })

  it('shows retryable per-file failures rather than clean/empty state', async () => {
    let attempts = 0
    mocks.invoke.mockImplementation(async (method) =>
      method === 'scm.status'
        ? context
        : method === 'scm.review'
          ? manifest
          : method === 'scm.diff'
            ? ++attempts === 1
              ? { ok: false, error: { message: 'File exceeds the review limit' } }
              : { ok: true, value: 'retried patch' }
            : { cancelled: true },
    )
    const user = userEvent.setup()
    render(<ReviewWorkspace scope={{ projectId: 'p' }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('File exceeds the review limit')
    await user.click(screen.getByRole('button', { name: 'Retry file' }))
    expect(await screen.findByText('retried patch')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
