import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationTask } from '@ari/contracts/orchestration'
import { DelegatedResult } from './DelegatedResult'
import { DelegationCard } from './DelegationCard'
import { TranscriptView } from './TranscriptView'
import {
  child,
  diffFixture,
  resultFixture,
  SNAPSHOT,
  taskFixture,
  viewFixture,
} from './result-fixtures.test-support'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: mocks }))
vi.mock('../diffs/DiffSurface', () => ({
  DiffSurface: (props: { path: string; comparisonId: string; diffText: string }) => (
    <div data-testid="diff" data-path={props.path} data-comparison={props.comparisonId}>
      {props.diffText}
    </div>
  ),
}))
let task: OrchestrationTask | null
let changed: () => void
let unsubscribe: ReturnType<typeof vi.fn>
beforeEach(() => {
  task = taskFixture()
  unsubscribe = vi.fn()
  mocks.subscribe.mockImplementation((_name, _params, callback) => {
    changed = callback
    return unsubscribe
  })
  mocks.invoke.mockImplementation(async (method, params) => {
    if (method === 'orchestration.view') return viewFixture(task)
    if (method === 'orchestration.diff') return diffFixture
    if (method === 'orchestration.review') {
      const result = task!.results.find((entry) => entry.resultId === params.resultId)!
      const updated = { ...result, reviewState: params.state }
      task = {
        ...task!,
        results: task!.results.map((entry) =>
          entry.resultId === updated.resultId ? updated : entry,
        ),
      }
      return updated
    }
    if (method === 'orchestration.integrate') {
      task = {
        ...task!,
        results: task!.results.map((entry) => ({ ...entry, reviewState: 'integrated' })),
      }
      return { status: 'integrated' }
    }
    if (method === 'orchestration.retry') {
      task = { ...task!, currentResultId: null, currentAttemptId: 'attempt-2' }
      return task
    }
    throw new Error(`Unexpected ${method}`)
  })
})
afterEach(() => {
  cleanup()
  mocks.invoke.mockReset()
  mocks.subscribe.mockReset()
})
const calls = (method: string) => mocks.invoke.mock.calls.filter(([name]) => name === method)
const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
  await screen.findByText('Search implemented.')
}
const mount = () => render(<DelegatedResult sessionId="parent" child={child} />)

describe('delegated result continuity', () => {
  it('loads nothing per row in a long transcript and threads the parent session into review', async () => {
    Element.prototype.scrollTo = () => {}
    const children = Array.from({ length: 80 }, (_, index) => ({
      ...child,
      sessionId: `worker-${index}`,
      title: `Task ${index}`,
    }))
    const { rerender } = render(
      <DelegationCard sessionId="parent" row={{ kind: 'delegation', key: 'group', children }} />,
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.subscribe).not.toHaveBeenCalled()
    rerender(
      <TranscriptView
        sessionId="parent"
        messages={[
          {
            id: 'prompt',
            sessionId: 'parent',
            turnId: null,
            role: 'user',
            parts: [{ type: 'text', text: 'Implement search' }],
            createdAt: 1,
          },
        ]}
        delegations={[child]}
      />,
    )
    await open()
    expect(calls('orchestration.view')[0]?.[1]).toEqual({ sessionId: 'parent' })
    expect(mocks.subscribe).toHaveBeenCalledWith(
      'orchestration.changed',
      { sessionId: 'parent' },
      expect.any(Function),
    )
  })

  it('inspects, accepts, and integrates the exact current result using the shared modal diff', async () => {
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByTestId('diff')).toHaveAttribute(
      'data-comparison',
      `${'b'.repeat(40)}:${SNAPSHOT}`,
    )
    expect(calls('orchestration.diff')[0]?.[1]).toEqual({
      sessionId: 'parent',
      taskId: 'task',
      resultId: 'result-1',
      patch: true,
    })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close review' }))
    await userEvent.click(screen.getByRole('button', { name: 'Accept result' }))
    const integrate = await screen.findByRole('button', { name: 'Integrate accepted result' })
    await waitFor(() => expect(integrate).toBeEnabled())
    expect(calls('orchestration.review')[0]?.[1]).toMatchObject({
      resultId: 'result-1',
      snapshotCommit: SNAPSHOT,
      state: 'accepted',
    })
    await userEvent.click(integrate)
    await screen.findByText('Version 1 integrated into the project.')
    expect(calls('orchestration.integrate')[0]?.[1]).toMatchObject({
      sessionId: 'parent',
      taskId: 'task',
      resultId: 'result-1',
      snapshotCommit: SNAPSHOT,
    })
  })

  it('keeps historical versions readable while disallowing acceptance and integration', async () => {
    task = taskFixture({
      currentResultId: 'result-2',
      results: [
        resultFixture({ summary: 'Older summary', reviewState: 'accepted' }),
        resultFixture({ resultId: 'result-2', version: 2 }),
      ],
    })
    mount()
    await open()
    await userEvent.selectOptions(screen.getByLabelText('Result version'), 'result-1')
    expect(screen.getByText('Older summary')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept result' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Integrate accepted result' })).toBeNull()
    expect(screen.getByText(/Historical version/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect current version' }))
    expect(screen.getByLabelText('Result version')).toHaveValue('result-2')
  })

  it('honestly distinguishes unavailable snapshots, report acceptance, and missing results', async () => {
    task = taskFixture({
      results: [resultFixture({ snapshotCommit: null, snapshotUnavailable: true })],
    })
    const { unmount } = mount()
    await open()
    expect(screen.getByRole('button', { name: 'Accept result' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull()
    expect(screen.getByText(/Snapshot unavailable/)).toBeInTheDocument()
    unmount()
    task = taskFixture({ results: [resultFixture({ snapshotCommit: null })] })
    const report = mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Accept report' }))
    await screen.findByText('Version 1 report accepted. No code was integrated.')
    expect(calls('orchestration.review')[0]?.[1]).toMatchObject({ snapshotCommit: null })
    expect(screen.queryByRole('button', { name: 'Integrate accepted result' })).toBeNull()
    report.unmount()
    task = null
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
    await screen.findByText(/No versioned result is available/)
  })

  it('preserves selection and feedback drafts across collapse and live result changes', async () => {
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Request correction' }))
    await userEvent.type(screen.getByLabelText('Correction feedback'), 'Handle empty queries')
    await userEvent.click(screen.getByRole('button', { name: 'Hide result for Search API' }))
    expect(unsubscribe).toHaveBeenCalled()
    task = taskFixture({
      currentResultId: 'result-2',
      results: [
        resultFixture(),
        resultFixture({ resultId: 'result-2', version: 2, summary: 'New result' }),
      ],
    })
    await open()
    expect(screen.getByLabelText('Correction feedback')).toHaveValue('Handle empty queries')
    await waitFor(() => expect(screen.getByText(/Historical version/)).toBeInTheDocument())
    expect(screen.getByLabelText('Result version')).toHaveValue('result-1')
    expect(screen.queryByText('New result')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send correction' })).toBeDisabled()
  })

  it('records exact feedback, then retries correction with atomic identity guards and stable keys', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    let failed = false
    mocks.invoke.mockImplementation((method, params) => {
      if (method === 'orchestration.retry' && !failed) {
        failed = true
        return Promise.reject(new Error('Connection lost'))
      }
      return fallback(method, params)
    })
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Request correction' }))
    await userEvent.type(screen.getByLabelText('Correction feedback'), 'Handle empty queries')
    await userEvent.click(screen.getByRole('button', { name: 'Send correction' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    expect(screen.getByText('Feedback saved. Correction has not started yet.')).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry correction for version 1' })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await screen.findByText('Correction requested for version 1.')
    expect(calls('orchestration.retry')).toHaveLength(2)
    expect(calls('orchestration.retry')[0]?.[1]).toEqual(calls('orchestration.retry')[1]?.[1])
    expect(calls('orchestration.review')[0]?.[1]).toEqual(calls('orchestration.review')[1]?.[1])
    expect(calls('orchestration.retry')[0]?.[1]).toMatchObject({
      expectedResultId: 'result-1',
      expectedAttemptId: 'attempt',
      expectedSnapshotCommit: SNAPSHOT,
      feedback: 'Handle empty queries',
    })
  })

  it('does not silently switch the target when current result changes during acceptance', async () => {
    let resolve!: (value: unknown) => void
    const fallback = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((method, params) =>
      method === 'orchestration.review'
        ? new Promise((done) => {
            resolve = done
          })
        : fallback(method, params),
    )
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Accept result' }))
    expect(screen.getByRole('button', { name: 'Accept result' })).toBeDisabled()
    expect(screen.getByLabelText('Result version')).toBeDisabled()
    task = taskFixture({
      currentResultId: 'result-2',
      results: [
        resultFixture(),
        resultFixture({ resultId: 'result-2', version: 2, summary: 'New result' }),
      ],
    })
    await act(async () => {
      changed()
    })
    await act(async () => {
      resolve(resultFixture({ reviewState: 'accepted' }))
    })
    await waitFor(() => expect(screen.getByText(/Historical version/)).toBeInTheDocument())
    expect(screen.getByLabelText('Result version')).toHaveValue('result-1')
    expect(calls('orchestration.review')[0]?.[1]).toMatchObject({
      resultId: 'result-1',
      snapshotCommit: SNAPSHOT,
    })
    expect(screen.queryByRole('button', { name: 'Integrate accepted result' })).toBeNull()
  })

  it('surfaces stale snapshot diff failures and leaves acceptance untouched', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((method, params) =>
      method === 'orchestration.diff'
        ? Promise.resolve({ ...diffFixture, currentSnapshotCommit: 'c'.repeat(40) })
        : fallback(method, params),
    )
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      'snapshot changed',
    )
    expect(screen.queryByTestId('diff')).toBeNull()
    expect(calls('orchestration.review')).toHaveLength(0)
    expect(calls('orchestration.integrate')).toHaveLength(0)
  })

  it('replays integration after a lost response with the same exact receipt', async () => {
    task = taskFixture({ results: [resultFixture({ reviewState: 'accepted' })] })
    const fallback = mocks.invoke.getMockImplementation()!
    let failed = false
    mocks.invoke.mockImplementation((method, params) => {
      if (method === 'orchestration.integrate' && !failed) {
        failed = true
        return Promise.reject(new Error('Connection lost'))
      }
      return fallback(method, params)
    })
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Integrate accepted result' }))
    await screen.findByRole('alert')
    const retry = screen.getByRole('button', { name: 'Retry integrate version 1' })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await screen.findByText('Version 1 integrated into the project.')
    expect(calls('orchestration.integrate')[0]?.[1]).toEqual(
      calls('orchestration.integrate')[1]?.[1],
    )
  })

  it('reports conflicts and uses a new operation only after a definitive conflict', async () => {
    task = taskFixture({ results: [resultFixture({ reviewState: 'accepted' })] })
    const fallback = mocks.invoke.getMockImplementation()!
    let conflict = true
    mocks.invoke.mockImplementation((method, params) => {
      if (method === 'orchestration.integrate' && conflict)
        return Promise.resolve({ status: 'conflict', files: ['src/search.ts'] })
      return fallback(method, params)
    })
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Integrate accepted result' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Integration conflicts: src/search.ts',
    )
    expect(screen.queryByText('Version 1 integrated into the project.')).toBeNull()
    conflict = false
    const button = screen.getByRole('button', { name: 'Integrate accepted result' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    await screen.findByText('Version 1 integrated into the project.')
    expect(calls('orchestration.integrate')[0]?.[1].idempotencyKey).not.toEqual(
      calls('orchestration.integrate')[1]?.[1].idempotencyKey,
    )
  })

  it('separates worker checks from independent whitespace checks and reports failure honestly', async () => {
    task = taskFixture({
      results: [
        resultFixture({
          workerReportedChecks: [
            {
              command: 'pnpm test',
              cwd: 'worker',
              exitCode: 0,
              snapshotCommit: null,
              detail: null,
            },
          ],
        }),
      ],
    })
    const fallback = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((method, params) =>
      method === 'orchestration.verify'
        ? Promise.resolve(
            resultFixture({
              verifiedChecks: [
                {
                  command: 'git diff --check',
                  cwd: 'worker',
                  exitCode: 1,
                  snapshotCommit: SNAPSHOT,
                  detail: 'Trailing whitespace',
                },
              ],
            }),
          )
        : fallback(method, params),
    )
    mount()
    await open()
    expect(screen.getByText(/Checks and provenance/)).toHaveTextContent(
      '1 worker reported · 0 independent',
    )
    await userEvent.click(screen.getByText(/Checks and provenance/))
    expect(screen.getByText(/does not run tests/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Check snapshot whitespace' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Trailing whitespace')
    expect(calls('orchestration.review')).toHaveLength(0)
    expect(screen.queryByText(/whitespace check passed/)).toBeNull()
  })

  it('handles failed detail reads with an explicit retry', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    let failed = false
    mocks.invoke.mockImplementation((method, params) => {
      if (method === 'orchestration.view' && !failed) {
        failed = true
        return Promise.reject(new Error('Offline'))
      }
      return fallback(method, params)
    })
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
    await userEvent.click(screen.getByRole('button', { name: 'Retry result' }))
    await screen.findByText('Search implemented.')
  })
})
