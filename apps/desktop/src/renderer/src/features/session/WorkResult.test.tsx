import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkResult } from './WorkResult'
import { SNAPSHOT, workResult, workTask } from './work-fixtures.test-support'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  rpcMocks.invoke.mockReset()
})

describe('WorkResult', () => {
  it('surfaces a failed snapshot check without a success notice or acceptance', async () => {
    rpcMocks.invoke.mockResolvedValue(
      workResult({
        verifiedChecks: [
          {
            command: 'git diff --check',
            cwd: '.',
            exitCode: 1,
            snapshotCommit: SNAPSHOT,
            detail: 'Trailing whitespace',
          },
        ],
      }),
    )
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({ currentResultId: 'result-1', results: [workResult()] })}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Check snapshot' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Trailing whitespace')
    expect(screen.queryByRole('status')).toBeNull()
    expect(rpcMocks.invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps an unavailable code snapshot distinct from a report-only result', () => {
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({
          currentResultId: 'result-1',
          results: [workResult({ snapshotCommit: null, snapshotUnavailable: true })],
        })}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getByText(/Snapshot unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept result' })).toBeDisabled()
  })
  it('records review feedback without claiming that it started a new worker attempt', async () => {
    rpcMocks.invoke.mockResolvedValue(workResult({ reviewState: 'changes_requested' }))
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({ currentResultId: 'result-1', results: [workResult()] })}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.type(screen.getByLabelText('Request changes'), 'Handle empty queries')
    await userEvent.click(screen.getByRole('button', { name: 'Record review feedback' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Retry the task')
    expect(rpcMocks.invoke).toHaveBeenCalledTimes(1)
    expect(rpcMocks.invoke).toHaveBeenCalledWith(
      'orchestration.review',
      expect.objectContaining({ state: 'changes_requested', feedback: 'Handle empty queries' }),
    )
  })
  it('integrates only the exact accepted version and reuses its receipt on retry', async () => {
    rpcMocks.invoke
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce({ status: 'integrated' })
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({
          currentResultId: 'result-1',
          results: [workResult({ reviewState: 'accepted' })],
        })}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Integrate accepted snapshot' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost')
    await userEvent.click(screen.getByRole('button', { name: 'Integrate accepted snapshot' }))
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalledTimes(2))
    expect(rpcMocks.invoke.mock.calls[0]?.[1]).toEqual(rpcMocks.invoke.mock.calls[1]?.[1])
    expect(rpcMocks.invoke.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ taskId: 'task-1', resultId: 'result-1', snapshotCommit: SNAPSHOT }),
    )
  })

  it('refuses a diff for a changed snapshot without accepting or integrating it', async () => {
    rpcMocks.invoke.mockResolvedValue({ currentSnapshotCommit: 'b'.repeat(40) })
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({ currentResultId: 'result-1', results: [workResult()] })}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Review diff' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('snapshot changed')
    expect(rpcMocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps historical results readable while disabling current-version actions', async () => {
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({
          currentResultId: 'result-2',
          results: [
            workResult({ summary: 'Old result' }),
            workResult({ resultId: 'result-2', version: 2 }),
          ],
        })}
        onChanged={vi.fn()}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Result'), 'result-1')
    expect(await screen.findByText('Old result')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept result' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Integrate accepted snapshot' })).toBeNull()
  })

  it('distinguishes worker-reported checks from verification tied to a snapshot', () => {
    const check = {
      command: 'pnpm test',
      cwd: '.',
      exitCode: 0,
      snapshotCommit: null,
      detail: null,
    }
    render(
      <WorkResult
        sessionId="lead"
        task={workTask({
          currentResultId: 'result-1',
          results: [workResult({ workerReportedChecks: [check] })],
        })}
        onChanged={vi.fn()}
      />,
    )
    expect(screen.getByText('Worker reported checks')).toBeInTheDocument()
    expect(screen.queryByText('Verified checks')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check snapshot' })).toBeInTheDocument()
  })
})
