import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChildTask } from '@ari/contracts/agent-control'
import { PlanPanel } from './PlanPanel'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

describe('PlanPanel', () => {
  beforeEach(() => {
    rpcMocks.invoke.mockReset()
  })

  // Paths stay forward-slashed: esbuild (the vitest JSX transform here)
  // double-escapes backslashes inside JSX string attributes, so a
  // `C:\repo` prop literal would arrive as `C:\\repo` at runtime.

  it('renders nothing when no plan file exists', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    const { container } = render(<PlanPanel sessionId="ses-1" />)
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('requests the plan scoped to the session', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    render(<PlanPanel sessionId="ses-1" />)
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith('plan.get', {
        sessionId: 'ses-1',
      }),
    )
  })

  it('refetches when the session changes so siblings never share a plan', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    const { rerender } = render(<PlanPanel sessionId="ses-1" />)
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith('plan.get', {
        sessionId: 'ses-1',
      }),
    )
    rerender(<PlanPanel sessionId="ses-2" />)
    await waitFor(() =>
      expect(rpcMocks.invoke).toHaveBeenCalledWith('plan.get', {
        sessionId: 'ses-2',
      }),
    )
    expect(rpcMocks.invoke).toHaveBeenCalledTimes(2)
  })

  it('renders nothing without fetching when the session is unknown', async () => {
    const { container } = render(<PlanPanel sessionId={null} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(rpcMocks.invoke).not.toHaveBeenCalled()
  })

  it('renders items with status icons and a progress count', async () => {
    rpcMocks.invoke.mockResolvedValue({
      items: [
        { text: 'parse input', status: 'done' },
        { text: 'refactor loop', status: 'in_progress' },
        { text: 'write tests', status: 'pending' },
      ],
    })
    render(<PlanPanel sessionId="ses-1" />)

    expect(await screen.findByText('parse input')).toBeInTheDocument()
    expect(screen.getByText('refactor loop')).toBeInTheDocument()
    expect(screen.getByText('write tests')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('collapses to the summary row on toggle', async () => {
    rpcMocks.invoke.mockResolvedValue({
      items: [{ text: 'only step', status: 'pending' }],
    })
    const user = userEvent.setup()
    render(<PlanPanel sessionId="ses-1" />)

    await screen.findByText('only step')
    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.queryByText('only step')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.getByText('only step')).toBeInTheDocument()
  })

  it("shows the lead's children with state and spend when no todo file exists", async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    const tasks: ChildTask[] = [
      task({ sessionId: 's1', title: 'Parse the schema', workState: 'queued' }),
      task({ sessionId: 's2', title: 'Refactor the loop', workState: 'working' }),
      task({ sessionId: 's3', title: 'Ask about the API', workState: 'blocked_on_user' }),
      task({ sessionId: 's4', title: 'Write the tests', workState: 'result_available' }),
    ]
    render(<PlanPanel sessionId="ses-1" tasks={tasks} />)

    expect(await screen.findByText('Team')).toBeInTheDocument()
    expect(screen.getByText('Parse the schema')).toBeInTheDocument()
    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText('Needs you')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    // Each child's own spend, and the summed per-model line.
    expect(screen.getAllByText('12.0K · $0.02')).toHaveLength(4)
    expect(screen.getByText('opus · 48.0K · $0.08')).toBeInTheDocument()
  })

  it('calls out incomplete cost when a child reported none', async () => {
    rpcMocks.invoke.mockResolvedValue({ items: null })
    render(
      <PlanPanel
        sessionId="ses-1"
        tasks={[
          task({
            sessionId: 's1',
            title: 'Local child',
            modelId: null,
            usage: { inputTokens: 9_000, outputTokens: 3_000, costUsd: null },
          }),
        ]}
      />,
    )

    expect(await screen.findByText('Team')).toBeInTheDocument()
    expect(screen.getByText('12.0K · cost incomplete')).toBeInTheDocument()
    expect(screen.getByText('claude · 12.0K · unpriced')).toBeInTheDocument()
  })

  it('keeps plan and team rows independent while sharing one session', async () => {
    rpcMocks.invoke.mockResolvedValue({
      items: [{ text: 'only step', status: 'pending' }],
    })
    render(<PlanPanel sessionId="ses-1" tasks={[task({ title: 'Child work' })]} />)

    expect(await screen.findByText('only step')).toBeInTheDocument()
    expect(screen.getByText('Child work')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /plan/i }))
    expect(screen.queryByText('only step')).not.toBeInTheDocument()
    expect(screen.getByText('Child work')).toBeInTheDocument()
  })

  it('survives invoke failures silently', async () => {
    rpcMocks.invoke.mockRejectedValue(new Error('ipc gone'))
    const { container } = render(<PlanPanel sessionId="ses-1" />)
    await waitFor(() => expect(rpcMocks.invoke).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})

function task(overrides: Partial<ChildTask> & Pick<ChildTask, 'title'>): ChildTask {
  return {
    sessionId: 's1',
    parentSessionId: 'ses-1',
    role: 'general',
    driverKind: 'claude',
    modelId: 'opus',
    workState: 'queued',
    blockedOn: null,
    queuedMessages: 0,
    latestTurn: null,
    report: null,
    reportTruncated: false,
    delivered: null,
    usage: { inputTokens: 9_000, outputTokens: 3_000, costUsd: 0.02 },
    workspaceKind: 'project',
    branch: null,
    ...overrides,
  }
}
