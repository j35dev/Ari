import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { DelegatedResultDiff } from './DelegatedResultDiff'
import {
  fileDiffFixture,
  manifestFixture,
  resultFixture,
  SNAPSHOT,
} from './result-fixtures.test-support'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('../diffs/DiffSurface', () => ({
  DiffSurface: (props: {
    path: string
    comparisonId: string
    diffText: string
    scrollOffset: number
    onScrollOffset: (value: number) => void
  }) => (
    <div
      data-testid="diff"
      data-path={props.path}
      data-comparison={props.comparisonId}
      data-offset={props.scrollOffset}
    >
      {props.diffText}
      <button onClick={() => props.onScrollOffset(120)}>Scroll file</button>
    </div>
  ),
}))
beforeEach(() => {
  mocks.invoke.mockImplementation(async (_method, params) =>
    params.kind === 'files'
      ? manifestFixture
      : { ...fileDiffFixture, path: params.path, patch: `patch for ${params.path}` },
  )
})
afterEach(() => {
  cleanup()
  mocks.invoke.mockReset()
})
const props = {
  open: true,
  onOpenChange: vi.fn(),
  title: 'Search API',
  sessionId: 'parent',
  taskId: 'task',
  target: resultFixture(),
}
const second = { path: 'second.ts', status: 'deleted', additions: 0, deletions: 1, binary: false }
const withFiles = () =>
  mocks.invoke.mockImplementation(async (_method, params) =>
    params.kind === 'files'
      ? {
          ...manifestFixture,
          files: [
            ...manifestFixture.files,
            second,
            { ...second, path: 'renamed.ts', oldPath: 'old.ts', status: 'renamed' },
            { ...second, path: 'image.png', binary: true },
          ],
        }
      : { ...fileDiffFixture, path: params.path, patch: `patch for ${params.path}` },
  )
const fileCalls = () => mocks.invoke.mock.calls.filter(([, params]) => params.kind === 'file')

it('loads metadata and only the selected small file for a result whose aggregate patch exceeds 2 MB', async () => {
  // The aggregate lives at the boundary; it is never returned to or split by the dialog.
  const aggregate = 'x'.repeat(2_000_001)
  mocks.invoke.mockImplementation(async (method, params) => {
    expect(method).toBe('orchestration.result.diff')
    expect(params).not.toHaveProperty('patch')
    if (params.kind === 'files')
      return {
        ...manifestFixture,
        files: [...manifestFixture.files, second],
        totals: { files: 2, additions: aggregate.length, deletions: 1 },
      }
    expect(params.path).toBe('src/search.ts')
    return fileDiffFixture
  })
  render(<DelegatedResultDiff {...props} />)
  expect(await screen.findByTestId('diff')).toHaveTextContent('+new')
  expect(mocks.invoke.mock.calls.map(([, p]) => p.kind)).toEqual(['files', 'file'])
  expect(fileCalls()[0]?.[1]).toMatchObject({
    resultId: 'result-1',
    attemptId: 'attempt',
    version: 1,
    snapshotCommit: SNAPSHOT,
    baseCommit: manifestFixture.baseCommit,
    path: 'src/search.ts',
  })
  expect(screen.queryByRole('combobox', { name: 'Compare changes' })).toBeNull()
})

it('preserves per-file scroll and handles deletion, rename and binary navigation without eager reads', async () => {
  withFiles()
  render(<DelegatedResultDiff {...props} />)
  await screen.findByTestId('diff')
  await userEvent.click(screen.getByRole('button', { name: 'Scroll file' }))
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'second.ts')
  await waitFor(() => expect(screen.getByTestId('diff')).toHaveAttribute('data-path', 'second.ts'))
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'src/search.ts')
  await waitFor(() => expect(screen.getByTestId('diff')).toHaveAttribute('data-offset', '120'))
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'renamed.ts')
  await waitFor(() => expect(screen.getByTestId('diff')).toHaveAttribute('data-path', 'renamed.ts'))
  expect(fileCalls().at(-1)?.[1]).toMatchObject({ path: 'renamed.ts', oldPath: 'old.ts' })
  expect(screen.getByTestId('diff')).toHaveAttribute(
    'data-comparison',
    `${manifestFixture.baseCommit}:${SNAPSHOT}`,
  )
  const count = fileCalls().length
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'image.png')
  expect(screen.getByText('Binary file changed. No text preview.')).toBeInTheDocument()
  expect(screen.queryByTestId('diff')).toBeNull()
  expect(fileCalls()).toHaveLength(count)
})

it('ignores a stale file reply after switching files', async () => {
  let resolve!: (value: unknown) => void
  mocks.invoke.mockImplementation(async (_method, p) =>
    p.kind === 'files'
      ? { ...manifestFixture, files: [...manifestFixture.files, second] }
      : p.path === 'src/search.ts'
        ? new Promise((done) => {
            resolve = done
          })
        : { ...fileDiffFixture, path: p.path, patch: 'selected deletion' },
  )
  render(<DelegatedResultDiff {...props} />)
  await screen.findByLabelText('Result changed file')
  await userEvent.selectOptions(screen.getByLabelText('Result changed file'), 'second.ts')
  expect(await screen.findByTestId('diff')).toHaveTextContent('selected deletion')
  await act(async () => {
    resolve({ ...fileDiffFixture, patch: 'obsolete' })
  })
  expect(screen.getByTestId('diff')).toHaveAttribute('data-path', 'second.ts')
  expect(screen.getByTestId('diff')).not.toHaveTextContent('obsolete')
})

it('rejects replies for a different base, result, attempt, version, snapshot or path', async () => {
  for (const mismatch of [
    { baseCommit: 'c'.repeat(40) },
    { resultId: 'another' },
    { attemptId: 'another' },
    { version: 2 },
    { currentSnapshotCommit: 'c'.repeat(40) },
    { path: 'another.ts' },
  ]) {
    mocks.invoke.mockImplementation(async (_method, p) =>
      p.kind === 'files' ? manifestFixture : { ...fileDiffFixture, ...mismatch },
    )
    const view = render(<DelegatedResultDiff {...props} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('comparison changed')
    expect(screen.queryByTestId('diff')).toBeNull()
    view.unmount()
  }
})

it('resets identity on prop changes and ignores pending old metadata', async () => {
  let resolve!: (value: unknown) => void
  mocks.invoke.mockImplementation(async (_method, p) =>
    p.resultId === 'result-1'
      ? new Promise((done) => {
          resolve = done
        })
      : p.kind === 'files'
        ? { ...manifestFixture, resultId: 'result-2', version: 2 }
        : { ...fileDiffFixture, resultId: 'result-2', version: 2, patch: 'new version' },
  )
  const { rerender } = render(<DelegatedResultDiff {...props} />)
  rerender(
    <DelegatedResultDiff {...props} target={resultFixture({ resultId: 'result-2', version: 2 })} />,
  )
  expect(await screen.findByTestId('diff')).toHaveTextContent('new version')
  await act(async () => {
    resolve(manifestFixture)
  })
  expect(screen.getByTestId('diff')).toHaveTextContent('new version')
  expect(fileCalls().every(([, p]) => p.resultId === 'result-2')).toBe(true)
})

it('reports missing snapshots and per-file limits truthfully and retries the same comparison', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('The selected result snapshot is unavailable.'))
  render(<DelegatedResultDiff {...props} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('snapshot is unavailable')
  expect(fileCalls()).toHaveLength(0)
  mocks.invoke.mockImplementation(async (_method, p) => {
    if (p.kind === 'files') return manifestFixture
    throw new Error('Git output exceeds the review limit. Open a smaller file.')
  })
  await userEvent.click(screen.getByRole('button', { name: 'Retry changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('review limit')
  const failed = fileCalls().at(-1)![1]
  mocks.invoke.mockResolvedValue(fileDiffFixture)
  await userEvent.click(screen.getByRole('button', { name: 'Retry file' }))
  expect(await screen.findByTestId('diff')).toHaveTextContent('+new')
  expect(fileCalls().at(-1)![1]).toEqual(failed)
})

it('handles empty results and empty text patches without claiming displayed changes', async () => {
  mocks.invoke.mockResolvedValue({ ...manifestFixture, files: [] })
  const view = render(<DelegatedResultDiff {...props} />)
  await screen.findByText('No changed files in this snapshot.')
  expect(fileCalls()).toHaveLength(0)
  view.unmount()
  mocks.invoke.mockImplementation(async (_method, p) =>
    p.kind === 'files' ? manifestFixture : { ...fileDiffFixture, patch: '' },
  )
  render(<DelegatedResultDiff {...props} />)
  await screen.findByText('No text patch available for this file.')
})

it('does not issue reads for report-only results', () => {
  render(<DelegatedResultDiff {...props} target={resultFixture({ snapshotCommit: null })} />)
  expect(screen.getByText('No code snapshot available for this result.')).toBeInTheDocument()
  expect(mocks.invoke).not.toHaveBeenCalled()
})

it('does not fetch when closed and supports keyboard dismissal with trigger focus restored', async () => {
  function Review() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Review snapshot
        </button>
        <DelegatedResultDiff {...props} open={open} onOpenChange={setOpen} />
      </>
    )
  }
  render(<Review />)
  expect(mocks.invoke).not.toHaveBeenCalled()
  const trigger = screen.getByRole('button', { name: 'Review snapshot' })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('dialog', { name: 'Search API · Version 1' })
  await screen.findByTestId('diff')
  screen.getByLabelText('Result changed file').focus()
  expect(screen.getByLabelText('Result changed file')).toHaveFocus()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(trigger).toHaveFocus()
})
