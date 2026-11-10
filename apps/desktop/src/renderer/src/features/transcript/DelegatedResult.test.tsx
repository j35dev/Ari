import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationTask } from '@ari/contracts/orchestration'
import { DelegatedResult } from './DelegatedResult'
import { DelegationCard } from './DelegationCard'
import { TranscriptView } from './TranscriptView'
import {
  child,
  fileDiffFixture,
  manifestFixture,
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
    if (method === 'orchestration.result.diff')
      return params.kind === 'files' ? manifestFixture : fileDiffFixture
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
    expect(calls('orchestration.result.diff')[0]?.[1]).toEqual({
      sessionId: 'parent',
      taskId: 'task',
      resultId: 'result-1',
      attemptId: 'attempt',
      version: 1,
      snapshotCommit: SNAPSHOT,
      kind: 'files',
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
    expect(
      screen.getByText('Feedback saved. Correction start is not confirmed yet.'),
    ).toBeInTheDocument()
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

  it('allows a fresh correction action after a durable rejection without reusing its failed receipt', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    let rejected: Record<string, unknown> | null = null
    let blocked = true
    mocks.invoke.mockImplementation((method, params) => {
      if (method === 'orchestration.view' && rejected)
        return Promise.resolve({
          ...viewFixture(task),
          operations: [
            {
              operationId: 'failed-correction',
              method: 'orchestration.retry',
              fingerprint: JSON.stringify(rejected),
              status: 'completed',
              result: { operationFailure: { code: 'task_running', message: 'Wait for worker' } },
            },
          ],
        })
      if (method === 'orchestration.retry' && blocked) {
        rejected = params
        // Like Electron IPC, this rejection has no custom code property.
        return Promise.reject(new Error('Wait for worker'))
      }
      return fallback(method, params)
    })
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Request correction' }))
    await userEvent.type(screen.getByLabelText('Correction feedback'), 'Handle empty queries')
    await userEvent.click(screen.getByRole('button', { name: 'Send correction' }))
    await screen.findByRole('alert')
    const send = screen.getByRole('button', { name: 'Send correction' })
    await waitFor(() => expect(send).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'Retry correction for version 1' })).toBeNull()
    blocked = false
    await userEvent.click(send)
    await screen.findByText('Correction requested for version 1.')
    const [first, second] = calls('orchestration.retry').map(([, params]) => params)
    expect(second).toEqual({ ...first, idempotencyKey: second.idempotencyKey })
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(calls('orchestration.review')[1]?.[1]).toEqual(calls('orchestration.review')[0]?.[1])
  })

  it('retains the exact correction receipt and draft when a started correction reply is lost', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    let lost: Record<string, unknown> | null = null
    mocks.invoke.mockImplementation((method, params) => {
      if (method === 'orchestration.view' && lost)
        return Promise.resolve({
          ...viewFixture(task),
          operations: [
            {
              operationId: 'uncertain-correction',
              method: 'orchestration.retry',
              fingerprint: JSON.stringify(lost),
              status: 'uncertain',
            },
          ],
        })
      if (method === 'orchestration.retry') {
        lost = params
        task = { ...task!, currentResultId: null, currentAttemptId: 'attempt-2' }
        return Promise.reject(new Error('Connection lost'))
      }
      return fallback(method, params)
    })
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Request correction' }))
    await userEvent.type(screen.getByLabelText('Correction feedback'), 'Handle empty queries')
    await userEvent.click(screen.getByRole('button', { name: 'Send correction' }))
    await screen.findByRole('alert')
    expect(
      screen.getByText('Feedback saved. Correction start is not confirmed yet.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Correction feedback')).toHaveValue('Handle empty queries')
    const retry = screen.getByRole('button', { name: 'Retry correction for version 1' })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await waitFor(() => expect(calls('orchestration.retry')).toHaveLength(2))
    expect(calls('orchestration.retry')[1]?.[1]).toEqual(calls('orchestration.retry')[0]?.[1])
  })

  it('surfaces stale snapshot diff failures and leaves acceptance untouched', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation((method, params) =>
      method === 'orchestration.result.diff'
        ? Promise.resolve({ ...manifestFixture, currentSnapshotCommit: 'c'.repeat(40) })
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

  it('reuses uncertain mutation arguments after collapse and a newer current result', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: 'Hide result for Search API' }))
    task = taskFixture({
      currentResultId: 'result-2',
      results: [
        resultFixture({ reviewState: 'accepted' }),
        resultFixture({ resultId: 'result-2', version: 2, snapshotCommit: 'c'.repeat(40) }),
      ],
    })
    await open()
    await screen.findByText(/Historical version/)
    const retry = screen.getByRole('button', { name: 'Retry integrate version 1' })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)
    await screen.findByText('Version 1 integrated into the project.')
    expect(calls('orchestration.integrate')[0]?.[1]).toEqual(
      calls('orchestration.integrate')[1]?.[1],
    )
    expect(calls('orchestration.integrate')[1]?.[1]).toMatchObject({
      resultId: 'result-1',
      snapshotCommit: SNAPSHOT,
    })
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

  it('keeps historical review pinned while the current result changes', async () => {
    mount()
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByTestId('diff')
    task = taskFixture({
      currentResultId: 'result-2',
      results: [
        resultFixture(),
        resultFixture({ resultId: 'result-2', version: 2, snapshotCommit: 'c'.repeat(40) }),
      ],
    })
    await act(async () => {
      changed()
    })
    expect(within(dialog).getByTestId('diff')).toHaveAttribute(
      'data-comparison',
      `${manifestFixture.baseCommit}:${SNAPSHOT}`,
    )
    expect(calls('orchestration.result.diff')).toHaveLength(2)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close review' }))
    expect(screen.getByLabelText('Result version')).toHaveValue('result-1')
    expect(screen.queryByRole('button', { name: 'Accept result' })).toBeNull()
  })

  it('ignores old session lookup and action replies after the row identity changes', async () => {
    const fallback = mocks.invoke.getMockImplementation()!
    let resolveView!: (value: unknown) => void
    mocks.invoke.mockImplementation((method, params) =>
      method === 'orchestration.view' && params.sessionId === 'parent'
        ? new Promise((done) => {
            resolveView = done
          })
        : fallback(method, params),
    )
    const { rerender } = mount()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
    rerender(<DelegatedResult sessionId="other-parent" child={child} />)
    await act(async () => {
      resolveView(viewFixture(task))
    })
    expect(screen.getByRole('button', { name: 'Inspect result for Search API' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(mocks.subscribe.mock.calls.at(-1)?.[1]).toEqual({ sessionId: 'parent' })
    mocks.invoke.mockImplementation(fallback)
    await open()
    let resolveAction!: (value: unknown) => void
    mocks.invoke.mockImplementation((method, params) =>
      method === 'orchestration.review'
        ? new Promise((done) => {
            resolveAction = done
          })
        : fallback(method, params),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Accept result' }))
    rerender(<DelegatedResult sessionId="third-parent" child={child} />)
    await act(async () => {
      resolveAction(resultFixture({ reviewState: 'accepted' }))
    })
    expect(screen.queryByText('Version 1 accepted.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Inspect result for Search API' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(calls('orchestration.view').at(-1)?.[1]).toEqual({ sessionId: 'other-parent' })
  })

  // A settled child result is a MarkdownBlock reply inside the parent transcript.
  it('renders flat and wrapped visuals from the child result summary', async () => {
    const flat =
      '{"version":1,"type":"metrics","title":"Saved","items":[{"label":"Hours","value":4}]}'
    const wrapped =
      '{"version":1,"type":"timeline","title":"Release progress","data":{"events":[{"label":"v0.2.0","date":"2026-08-30","description":"Previous release"},{"label":"v0.3.13","date":"in progress","tone":"warning"}]}}'
    const summary = [
      'Before',
      '',
      '```ari-viz',
      flat,
      '```',
      '',
      '```ari-viz',
      wrapped,
      '```',
      '',
      'After',
    ].join('\n')
    task = taskFixture({ results: [resultFixture({ summary })] })
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
    expect(await screen.findByRole('figure', { name: 'Saved' })).toBeInTheDocument()
    expect(screen.getByText('Hours')).toBeInTheDocument()
    const timeline = screen.getByRole('figure', { name: 'Release progress' })
    expect(within(timeline).getByText('v0.2.0').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-accent)',
    )
    expect(within(timeline).getByText('v0.3.13').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-warning)',
    )
    expect(document.querySelector('code.language-ari-viz')).toBeNull()
  })

  it('names a child-result visualization error without echoing markup', async () => {
    task = taskFixture({
      results: [
        resultFixture({
          summary: '```ari-viz\n{"version":1,"type":"timeline","title":"Missing events"}\n```',
        }),
      ],
    })
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
    expect(await screen.findByText('Timeline charts need events.')).toBeInTheDocument()
    expect(screen.queryByText('Invalid input')).toBeNull()
    task = taskFixture({
      results: [
        resultFixture({
          summary:
            '```ari-viz\n{"version":1,"type":"timeline","title":"Marked up","events":[{"label":"A"}],"html":"<script>alert(1)</script>"}\n```',
        }),
      ],
    })
    cleanup()
    mount()
    await userEvent.click(screen.getByRole('button', { name: 'Inspect result for Search API' }))
    expect(await screen.findByText('Timeline charts cannot include "html".')).toBeInTheDocument()
    expect(screen.queryByText(/alert\(1\)/)).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
})
