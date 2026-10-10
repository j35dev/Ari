// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { SessionScreen } from './SessionScreen'

const snapshot = {
  session: {
    id: 'sess_1',
    projectId: 'proj_1',
    title: 'Fix pairing',
    driverKind: 'codex',
    modelId: 'gpt',
    permissionMode: 'ask',
    effort: null as string | null,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  },
  summary: { id: 'sess_1', projectId: 'proj_1', title: 'Fix pairing', updatedAt: 1 },
  seq: 0,
  messages: [],
  pendingApprovals: [] as unknown[],
  pendingInputs: [] as unknown[],
}
const catalog: RemoteModelCatalog = {
  providers: [
    {
      driverKind: 'codex',
      available: true,
      models: [{ id: 'gpt', label: 'GPT' }],
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High', current: true },
      ],
      modes: [],
    },
  ],
}
const app = vi.hoisted(() => ({
  origin: 'https://phone.test',
  connection: 'connected',
  projects: [{ id: 'proj_1', name: 'Ari' }],
  sessions: [] as { id: string; title: string }[],
  catalog: null as RemoteModelCatalog | null,
  managedComputerId: null,
  refresh: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  session: {
    deviceId: 'phone',
    usable: true,
    supports: vi.fn((op: string) => op !== 'events.subscribe' && op !== 'models.efforts'),
    query: vi.fn<(op: string, params: unknown) => Promise<unknown>>(),
    send: vi.fn<(command: unknown) => Promise<unknown>>(),
  },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))

beforeEach(() => {
  // jsdom lays nothing out, so it has no element scrolling to call.
  Element.prototype.scrollTo = vi.fn()
  sessionStorage.clear()
  app.catalog = catalog
  snapshot.session.status = 'idle'
  snapshot.pendingApprovals = []
  snapshot.pendingInputs = []
  app.session.query.mockResolvedValue(snapshot)
  app.session.send.mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('session controls in the composer', () => {
  it('sets the effort the user picks on this session', async () => {
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Effort: High' }))
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.update',
        sessionId: 'sess_1',
        effort: 'low',
      }),
    )
  })

  it('sets the permission mode the user picks, even while the agent is working', async () => {
    snapshot.session.status = 'running'
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions: Ask' }))
    fireEvent.click(screen.getByRole('button', { name: /^Full auto/ }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.update',
        sessionId: 'sess_1',
        permissionMode: 'full',
      }),
    )
  })

  it('keeps the model locked while the agent is working', async () => {
    snapshot.session.status = 'running'
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    const model = await screen.findByRole('button', { name: 'Model: GPT' })
    expect((model as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a refused change instead of pretending it applied', async () => {
    app.session.send.mockRejectedValue(new Error('this provider does not offer that effort level'))
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Effort: High' }))
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('does not offer that effort')
  })
})

describe('when the agent is waiting on the user', () => {
  const approval = {
    approvalId: 'ap_1',
    toolName: 'Bash',
    summaryJson: JSON.stringify({ command: 'pnpm verify' }),
    options: [
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ],
  }

  it('puts the request where the composer was, and sends back the choice', async () => {
    snapshot.session.status = 'waiting-approval'
    snapshot.pendingApprovals = [approval]
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Run this command?' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Message the agent' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'approval.respond',
        sessionId: 'sess_1',
        approvalId: 'ap_1',
        optionId: 'once',
      }),
    )
  })

  it('sends back the answer to a question', async () => {
    snapshot.pendingInputs = [{ inputId: 'in_1', prompt: 'Which branch?', choicesJson: null }]
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.change(await screen.findByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'main' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'input.respond',
        sessionId: 'sess_1',
        inputId: 'in_1',
        value: 'main',
      }),
    )
  })

  it('brings the composer back once nothing is pending', async () => {
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    expect(await screen.findByRole('textbox', { name: 'Message the agent' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'The agent is waiting for you' })).toBeNull()
  })
})

describe('the session header', () => {
  it('opens changes directly and keeps the rest in one menu', async () => {
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Fix pairing' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('button', { name: 'Files' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(screen.getByRole('heading', { name: 'Fix pairing' })).toBeTruthy()
  })

  it('leaves the session from the chat', async () => {
    const onBack = vi.fn()
    render(<SessionScreen sessionId="sess_1" onBack={onBack} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalledOnce()
  })
})

describe('delegated agents', () => {
  const task = (sessionId: string, title: string, fields: Record<string, unknown> = {}) => ({
    sessionId,
    parentSessionId: 'sess_1',
    title,
    role: 'research',
    driverKind: 'claude',
    modelId: null,
    workState: 'working',
    blockedOn: null,
    queuedMessages: 0,
    latestTurn: null,
    report: null,
    reportTruncated: false,
    delivered: false,
    workspaceKind: 'project',
    branch: null,
    ...fields,
  })
  const done = task('child_done', 'Parser', {
    workState: 'result_available',
    latestTurn: { turnId: 't', stopReason: 'completed', settledAt: 1 },
    report: 'Parser fixed and tested.',
  })

  it('says how the delegated work is going and opens an agent from the sheet', async () => {
    app.session.query.mockResolvedValue({
      ...snapshot,
      tasks: [done, task('child_busy', 'Docs'), task('child_ask', 'Tests', { workState: 'blocked_on_user' })],
    })
    const onOpen = vi.fn()
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={onOpen} />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Delegated agents: 3 agents · 1 needs you · 1 working · 1 done',
      }),
    )
    // Its own turn is over, but the work is not: the header must not say "ready".
    expect(screen.getByText('Ari, waiting on 1 agent')).toBeTruthy()
    expect(screen.getByText('Parser fixed and tested.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open Tests: Needs you' }))
    expect(onOpen).toHaveBeenCalledWith('child_ask')
  })

  it('stops every running agent from the sheet, and only those', async () => {
    app.session.query.mockResolvedValue({
      ...snapshot,
      tasks: [done, task('child_busy', 'Docs'), task('child_ask', 'Tests', { workState: 'blocked_on_user' })],
    })
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Delegated agents:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop all agents' }))
    await waitFor(() =>
      expect(app.session.send.mock.calls.map(([command]) => command)).toEqual([
        { op: 'session.interrupt', sessionId: 'child_busy' },
        { op: 'session.interrupt', sessionId: 'child_ask' },
      ]),
    )
  })

  it('shows nothing extra for a session that delegated nothing, including on an older desktop', async () => {
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    await screen.findByRole('heading', { name: 'Fix pairing' })
    expect(screen.queryByRole('button', { name: /^Delegated agents:/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Open parent session/ })).toBeNull()
    expect(screen.getByText('Ari, ready')).toBeTruthy()
  })

  it('links a delegated agent back to the session it works for', async () => {
    app.session.query.mockResolvedValue({
      ...snapshot,
      parent: { id: 'sess_lead', title: 'Ship settings' },
    })
    const onOpen = vi.fn()
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={onOpen} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open parent session: Ship settings' }),
    )
    expect(onOpen).toHaveBeenCalledWith('sess_lead')
  })
})
