import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkPanel } from './WorkPanel'
import { workResult, workTask, workView } from './work-fixtures.test-support'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => undefined) }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  rpcMocks.invoke.mockReset()
})
const props = {
  sessionId: 'lead',
  defaults: { driverKind: 'codex' as const, modelId: null, permissionMode: 'ask' as const },
  onChanged: vi.fn(),
  onClose: vi.fn(),
}

describe('WorkPanel', () => {
  it('inspects the context actually received by an attempt', async () => {
    rpcMocks.invoke.mockResolvedValue({
      contextId: 'context-1',
      chars: 17,
      maxChars: 100,
      items: [
        { kind: 'message', sourceId: 'message-1', content: 'Received contract', truncated: false },
      ],
    })
    const task = workTask()
    task.attempts[0]!.contextId = 'context-1'
    render(<WorkPanel {...props} view={workView([task])} />)
    await userEvent.click(screen.getByRole('button', { name: /Search API/ }))
    await userEvent.click(screen.getByText('Attempt history (1)'))
    await userEvent.click(screen.getByRole('button', { name: 'Inspect received context' }))
    expect(await screen.findByRole('region', { name: 'Received context' })).toHaveTextContent(
      'Received contract',
    )
    expect(rpcMocks.invoke).toHaveBeenCalledWith('orchestration.context.get', {
      sessionId: 'lead',
      contextId: 'context-1',
    })
  })
  it('starts an explicit follow-up attempt for a finished task instead of leaving a note in an idle inbox', async () => {
    rpcMocks.invoke.mockResolvedValue({})
    const task = workTask({
      currentResultId: 'result-1',
      results: [workResult({ reviewState: 'changes_requested' })],
      currentActivity: {
        ...workTask().currentActivity,
        phase: 'ended',
        terminalStatus: 'completed',
      },
    })
    render(<WorkPanel {...props} view={workView([task])} />)
    await userEvent.click(screen.getByRole('button', { name: /Search API/ }))
    await userEvent.type(screen.getByLabelText('Follow-up for this agent'), 'Handle empty queries')
    await userEvent.click(screen.getByRole('button', { name: 'Start follow-up attempt' }))
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith(
        'orchestration.retry',
        expect.objectContaining({
          taskId: 'task-1',
          feedback: 'Handle empty queries',
          newSession: false,
        }),
      ),
    )
  })
  it('recovers an uncertain submission through an explicit new session', async () => {
    rpcMocks.invoke.mockResolvedValue({})
    const task = workTask({
      currentActivity: {
        ...workTask().currentActivity,
        phase: 'unknown',
        waitReason: 'disconnected',
        freshness: 'unavailable',
      },
    })
    render(<WorkPanel {...props} view={workView([task])} />)
    await userEvent.click(screen.getByRole('button', { name: /Search API/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Recover in new session' }))
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith(
        'orchestration.retry',
        expect.objectContaining({ newSession: true }),
      ),
    )
  })
  it('browses fifteen active tasks while folding a larger result history', () => {
    const active = Array.from({ length: 15 }, (_, index) =>
      workTask({ taskId: `active-${index}`, title: `Active task ${index}` }),
    )
    const history = Array.from({ length: 100 }, (_, index) =>
      workTask({
        taskId: `history-${index}`,
        title: `Finished task ${index}`,
        currentActivity: {
          ...workTask().currentActivity,
          phase: 'ended',
          terminalStatus: 'completed',
          freshness: 'journal',
        },
      }),
    )
    const { rerender } = render(<WorkPanel {...props} view={workView([...active, ...history])} />)
    expect(screen.getByRole('list', { name: 'Tasks' }).querySelectorAll('button')).toHaveLength(15)
    const settled = { ...active[0]!, currentActivity: history[0]!.currentActivity }
    rerender(<WorkPanel {...props} view={workView([settled, ...active.slice(1), ...history])} />)
    expect(screen.getByRole('list', { name: 'Tasks' }).querySelector('button')).toHaveTextContent(
      'Active task 0',
    )
    expect(screen.getByRole('button', { name: 'Show completed work (101)' })).toBeInTheDocument()
  })
  it('pins compared result versions when an agent reports a newer result', async () => {
    const first = workTask({
      baseSnapshotCommit: 'a'.repeat(40),
      results: [workResult({ summary: 'Original report' })],
      currentResultId: 'result-1',
    })
    const second = workTask({
      taskId: 'task-2',
      title: 'Search alternative',
      baseSnapshotCommit: first.baseSnapshotCommit,
      results: [workResult({ resultId: 'result-2', taskId: 'task-2' })],
      currentResultId: 'result-2',
    })
    const { rerender } = render(<WorkPanel {...props} view={workView([first, second])} />)
    await userEvent.click(screen.getByRole('button', { name: /^Results/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Compare Search API' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Compare Search alternative' }))
    expect(screen.getByRole('region', { name: 'Result comparison' })).toHaveTextContent(
      'Common workspace base',
    )
    const newer = workResult({ resultId: 'result-3', version: 2, summary: 'New report' })
    rerender(
      <WorkPanel
        {...props}
        view={workView([
          { ...first, currentResultId: newer.resultId, results: [...first.results, newer] },
          second,
        ])}
      />,
    )
    const comparison = screen.getByRole('region', { name: 'Result comparison' })
    expect(comparison).toHaveTextContent('Original report')
    expect(comparison).toHaveTextContent('Historical version')
    expect(comparison).not.toHaveTextContent('New report')
  })
  it('keeps failed and interrupted work visible without unfolding completed results', () => {
    const failed = workTask({
      currentActivity: {
        ...workTask().currentActivity,
        phase: 'ended',
        terminalStatus: 'failed',
        freshness: 'journal',
      },
    })
    const interrupted = workTask({
      taskId: 'task-2',
      title: 'Search UI',
      currentActivity: { ...failed.currentActivity, terminalStatus: 'interrupted' },
    })
    render(<WorkPanel {...props} view={workView([failed, interrupted])} />)
    expect(screen.getByRole('button', { name: /Search API/ })).toHaveTextContent('Failed')
    expect(screen.getByRole('button', { name: /Search UI/ })).toHaveTextContent('Interrupted')
    expect(screen.queryByRole('button', { name: /Show completed work/ })).toBeNull()
  })
  it('offers retry for a finished result that needs changes', async () => {
    const task = workTask({
      results: [workResult({ reviewState: 'changes_requested' })],
      currentResultId: 'result-1',
      currentActivity: {
        ...workTask().currentActivity,
        phase: 'ended',
        terminalStatus: 'completed',
        freshness: 'journal',
      },
    })
    render(<WorkPanel {...props} view={workView([task])} />)
    await userEvent.click(screen.getByRole('button', { name: /Search API/ }))
    expect(screen.getByRole('button', { name: 'Retry task' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop task' })).toBeNull()
  })
  it('keeps result-ready work folded and exposes it in Results', async () => {
    const ended = workTask({
      results: [workResult()],
      currentResultId: 'result-1',
      currentActivity: {
        phase: 'ended',
        waitReason: null,
        decisionOwner: null,
        terminalStatus: 'completed',
        detail: null,
        observedAt: 100,
        freshness: 'journal',
      },
    })
    render(<WorkPanel {...props} view={workView([ended])} />)
    expect(screen.queryByRole('button', { name: /Search API/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show completed work (1)' }))
    expect(screen.getByRole('button', { name: /Search API/ })).toHaveTextContent('Result ready')
    await userEvent.click(screen.getByRole('button', { name: /^Results/ }))
    await userEvent.click(screen.getByRole('button', { name: /Search API/ }))
    expect(screen.getByRole('region', { name: 'Result review' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Integrate accepted snapshot' })).toBeNull()
  })

  it('answers a child approval from the parent using the exact offered option', async () => {
    rpcMocks.invoke.mockResolvedValue({ answered: true, requestId: 'approval-7' })
    const task = workTask({
      requests: [
        {
          requestId: 'approval-7',
          childSessionId: 'worker-1',
          turnId: 'turn-1',
          title: 'Search API',
          kind: 'approval',
          owner: 'human',
          prompt: 'Run tests',
          toolName: 'Shell',
          summaryJson: '{"command":"pnpm test"}',
          choicesJson: null,
          options: [{ optionId: 'custom-grant-3', name: 'Allow this command', kind: 'allow_once' }],
          actionable: true,
          unavailableReason: null,
        },
      ],
    })
    render(<WorkPanel {...props} view={workView([task])} />)
    await userEvent.click(screen.getByRole('button', { name: /^Decisions/ }))
    await userEvent.click(screen.getByRole('button', { name: /Allow this command/ }))
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith(
        'orchestration.answer',
        expect.objectContaining({
          sessionId: 'lead',
          childSessionId: 'worker-1',
          requestId: 'approval-7',
          kind: 'approval',
          value: 'custom-grant-3',
        }),
      ),
    )
    expect(await screen.findByText('Answer sent')).toBeInTheDocument()
  })

  it('retains task row order across changes in attention', () => {
    const a = workTask()
    const b = workTask({ taskId: 'task-2', title: 'Search UI' })
    const { rerender } = render(<WorkPanel {...props} view={workView([a, b])} />)
    b.currentActivity = { ...b.currentActivity, decisionOwner: 'human', phase: 'waiting' }
    rerender(<WorkPanel {...props} view={workView([a, b])} />)
    const rows = screen.getByRole('list', { name: 'Tasks' }).querySelectorAll('button')
    expect(rows[0]).toHaveTextContent('Search API')
    expect(rows[1]).toHaveTextContent('Search UI')
    expect(rows[1]).toHaveTextContent('Needs you')
  })

  it('makes a narrow drawer modal, traps focus, and restores the reading surface', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 480,
    } as DOMRect)
    const before = document.createElement('button')
    before.textContent = 'Details'
    document.body.append(before)
    before.focus()
    const { unmount } = render(
      <div>
        <main data-testid="conversation">
          <textarea aria-label="Draft" defaultValue="Keep this draft" />
        </main>
        <WorkPanel {...props} view={workView()} />
      </div>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Work details' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByTestId('conversation').inert).toBe(true)
    const close = screen.getByRole('button', { name: 'Close work details' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement?.tagName).toBe('SUMMARY')
    act(() => {
      unmount()
    })
    expect(before).toHaveFocus()
    before.remove()
  })

  it('keeps native work inspectable without offering unsupported retry or handoff', async () => {
    const native = workTask({
      native: { taskId: 'native-task', sessionId: 'lead', kind: 'subagent' },
      assignment: null,
      capabilities: {
        inspect: true,
        message: false,
        stop: false,
        steer: false,
        answer: false,
        nativeFork: false,
        respondAfterReconnect: false,
        unavailableReason: 'Provider-native work is read only.',
      },
    })
    render(<WorkPanel {...props} view={workView([native])} />)
    await userEvent.click(screen.getByRole('button', { name: /Search API/ }))
    expect(screen.getByRole('button', { name: 'Stop task' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Fork or change provider' })).toBeNull()
    expect(screen.queryByLabelText('Follow-up for this agent')).toBeNull()
  })
})
