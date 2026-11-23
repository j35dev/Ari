import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { SessionView, type SessionDefaults } from './SessionView'
import { dropDraftIntentMemory } from '../composer/draft-recovery-store'
import { dropDraftTextMemory } from '../composer/use-drafts'
import { keepAliveActions } from './session-keep-alive'

if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
vi.mock('../scene/DitherScene', () => ({ DitherScene: () => <div data-testid="scene" /> }))
vi.mock('../moment/settle-sound', () => ({ playSettleSound: vi.fn() }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>
const DEFAULTS: SessionDefaults = {
  driverKind: 'claude',
  modelId: 'haiku',
  permissionMode: 'ask',
  effort: null,
}
const SESSION = {
  id: 'sess_1',
  projectId: 'proj_1',
  title: 'Parent chat',
  driverKind: 'claude',
  modelId: 'haiku',
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
}
const SETTINGS = {
  version: 1,
  appearance: { themeId: 'obsidian', mode: 'system', reducedMotion: false, wallpaper: 'none' },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  notifications: { settleSound: false },
  permissions: { allowlist: [] },
  window: null,
}
const AGENT_CALL = 'toolu_agent'

let listener: ((payload: unknown) => void) | null = null
let seq = 0
function emit(event: Record<string, unknown>): void {
  seq++
  act(() =>
    listener?.({ sessionId: 'sess_1', event: { seq, at: seq, sessionId: 'sess_1', ...event } }),
  )
}

beforeEach(() => {
  keepAliveActions.reset()
  dropDraftIntentMemory()
  dropDraftTextMemory()
  localStorage.clear()
  seq = 0
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (method) => {
    if (method === 'settings.get') return SETTINGS
    if (method === 'project.list') return []
    if (method === 'session.workspace') return { path: null }
    if (method === 'files.index') return { paths: [] }
    if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
    if (method === 'providers.detect') return []
    if (method === 'providers.models') return []
    if (method === 'endpoints.list') return []
    if (method === 'command.dispatch') return { accepted: true }
    if (method === 'session.stopChildren') return { stopped: 1 }
    if (method === 'git.turnDiff') return {}
    throw new Error(`unexpected method: ${String(method)}`)
  })
  rpcMocks.subscribe.mockImplementation(
    (name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
      if (name === 'session.events') {
        listener = onEvent
        act(() => onEvent({ sessionId: 'sess_1', replayDone: true }))
      }
      return () => undefined
    },
  )
})
afterEach(() => {
  listener = null
  vi.clearAllMocks()
})

function renderView(kind: 'claude' | 'qoder' = 'claude'): void {
  render(
    <ToastProvider>
      <SessionView
        sessionId="sess_1"
        defaults={{ ...DEFAULTS, driverKind: kind }}
        onDefaultsChange={() => undefined}
      />
    </ToastProvider>,
  )
}

/** The parent starts a background subagent and ends its own turn while it runs. */
function parentTurnWithBackgroundSubagent(): void {
  emit({ type: 'turn.started', turnId: 'turn_1' })
  emit({
    type: 'assistant.parts.appended',
    messageId: 'msg_1',
    parts: [
      {
        type: 'tool-call',
        callId: AGENT_CALL,
        name: 'Agent',
        argsJson: JSON.stringify({
          description: 'List files in working folder',
          subagent_type: 'general-purpose',
          run_in_background: true,
          prompt: 'List the files here.',
        }),
      },
      {
        type: 'tool-result',
        callId: AGENT_CALL,
        resultJson: JSON.stringify([{ type: 'text', text: 'Async agent launched successfully.' }]),
        isError: false,
      },
      { type: 'text', text: 'Started a subagent; I will summarise when it is done.' },
    ],
  })
  emit({
    type: 'background.task.updated',
    taskId: AGENT_CALL,
    kind: 'subagent',
    label: 'List files in working folder',
    status: 'running',
    subagentType: 'general-purpose',
    prompt: 'List the files here.',
    model: 'claude-haiku-5-5',
  })
  emit({
    type: 'background.task.parts.appended',
    taskId: AGENT_CALL,
    parts: [
      {
        type: 'tool-call',
        callId: 'toolu_child',
        name: 'Bash',
        argsJson: JSON.stringify({ command: 'ls -la', description: 'List the folder' }),
      },
    ],
  })
  emit({ type: 'session.status.changed', from: 'running', to: 'idle', reason: null })
  emit({ type: 'turn.settled', turnId: 'turn_1', stopReason: 'completed', errorMessage: null })
}

describe('SessionView with Claude subagents', () => {
  it('keeps a Qoder child’s native-ID approval answerable after the parent settles and on replay', async () => {
    renderView('qoder')
    await screen.findByRole('textbox', { name: 'Message' })
    parentTurnWithBackgroundSubagent()
    emit({
      type: 'background.task.updated',
      taskId: AGENT_CALL,
      nativeTaskId: 'native-agent',
      kind: 'subagent',
      label: 'List files in working folder',
      status: 'running',
    })
    emit({
      type: 'approval.requested',
      approvalId: 'child-approval',
      taskId: 'native-agent',
      toolName: 'Bash',
      summaryJson: '{}',
      options: [],
    })
    const label = 'Approval requested: Bash by Qoder subagent · List files in working folder'
    expect(await screen.findByRole('group', { name: label })).toBeInTheDocument()
    emit({ type: 'turn.started', turnId: 'turn_2' })
    emit({ type: 'turn.settled', turnId: 'turn_2', stopReason: 'completed' })
    expect(screen.getByRole('group', { name: label })).toBeInTheDocument()
    act(() => listener?.({ sessionId: 'sess_1', replayStart: true }))
    act(() => listener?.({ sessionId: 'sess_1', replay: true, events: [] }))
    // The retry's history contains no new records; use resume semantics.
    act(() =>
      listener?.({
        sessionId: 'sess_1',
        replayDone: true,
        replayOutcome: 'complete',
        replayMode: 'resume',
        liveTurnId: null,
      }),
    )
    expect(screen.getByRole('group', { name: label })).toBeInTheDocument()
    emit({
      type: 'background.task.updated',
      taskId: AGENT_CALL,
      kind: 'subagent',
      label: 'List files in working folder',
      status: 'stopped',
    })
    expect(screen.queryByRole('group', { name: label })).not.toBeInTheDocument()
  })
  it('merges late launch/native binding without losing an open child transcript', async () => {
    renderView('qoder')
    await screen.findByRole('textbox', { name: 'Message' })
    emit({ type: 'turn.started', turnId: 'turn_1' })
    emit({
      type: 'assistant.parts.appended',
      messageId: 'm1',
      parts: [{ type: 'tool-call', callId: AGENT_CALL, name: 'Agent', argsJson: '{}' }],
    })
    for (const id of ['native', AGENT_CALL])
      emit({
        type: 'background.task.updated',
        taskId: id,
        providerItemId: id,
        providerThreadId: 's',
        kind: 'subagent',
        label: 'Bound fixture',
        status: 'running',
      })
    emit({
      type: 'background.task.parts.appended',
      taskId: AGENT_CALL,
      parts: [{ type: 'text', text: 'Before binding.' }],
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open Qoder subagent: Bound fixture' }),
    )
    emit({
      type: 'background.task.updated',
      taskId: 'native',
      providerItemId: AGENT_CALL,
      providerThreadId: 's',
      kind: 'subagent',
      label: 'Bound fixture',
      status: 'running',
    })
    emit({
      type: 'background.task.parts.appended',
      taskId: 'native',
      parts: [{ type: 'text', text: 'After binding.' }],
    })
    const view = await screen.findByRole('region', { name: 'Qoder subagent: Bound fixture' })
    expect(within(view).getByText(/Before binding/)).toBeInTheDocument()
    expect(within(view).getByText(/After binding/)).toBeInTheDocument()
    fireEvent.click(within(view).getByRole('button', { name: /Open parent session/ }))
    expect(screen.getByRole('button', { name: 'Child sessions' })).toHaveTextContent('1 agent')
  })
  it('shows Qoder native agents in the same row/list/detail UI with Qoder labels', async () => {
    renderView('qoder')
    await screen.findByRole('textbox', { name: 'Message' })
    parentTurnWithBackgroundSubagent()
    const row = await screen.findByRole('button', {
      name: 'Open Qoder subagent: List files in working folder',
    })
    expect(row).toHaveTextContent('Qoder subagent · general-purpose')
    fireEvent.click(screen.getByRole('button', { name: 'Child sessions' }))
    const list = await screen.findByRole('list', { name: 'Child sessions' })
    expect(within(list).getByText('Qoder subagent')).toBeInTheDocument()
    fireEvent.click(row)
    const view = await screen.findByRole('region', {
      name: 'Qoder subagent: List files in working folder',
    })
    expect(within(view).getByText('List the files here.')).toBeInTheDocument()
    emit({
      type: 'background.task.parts.appended',
      taskId: AGENT_CALL,
      parts: [{ type: 'text', text: 'Qoder fixture report.', streamId: 'qoder-child' }],
    })
    expect(await within(view).findByText('Qoder fixture report.')).toBeInTheDocument()
    expect(within(view).queryByText('Claude subagent')).not.toBeInTheDocument()
  })
  it('opens the canonical task when its native ID differs from its launching call', async () => {
    renderView('qoder')
    await screen.findByRole('textbox', { name: 'Message' })
    emit({ type: 'turn.started', turnId: 'turn_1' })
    emit({
      type: 'assistant.parts.appended',
      messageId: 'm1',
      parts: [{ type: 'tool-call', callId: AGENT_CALL, name: 'Agent', argsJson: '{}' }],
    })
    emit({
      type: 'background.task.updated',
      taskId: 'native-task',
      providerItemId: AGENT_CALL,
      kind: 'subagent',
      label: 'Native fixture',
      status: 'running',
    })
    emit({
      type: 'background.task.parts.appended',
      taskId: 'native-task',
      parts: [{ type: 'text', text: 'Canonical child content.' }],
    })
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open Qoder subagent: Native fixture' }),
    )
    const view = await screen.findByRole('region', { name: 'Qoder subagent: Native fixture' })
    expect(within(view).getByText('Canonical child content.')).toBeInTheDocument()
  })
  it('keeps the parent sendable and its transcript free of the subagent’s work', async () => {
    renderView()
    const input = await screen.findByRole('textbox', { name: 'Message' })
    parentTurnWithBackgroundSubagent()

    // One compact row for the Agent call, and none of the subagent's tools.
    const row = await screen.findByRole('button', {
      name: 'Open Claude subagent: List files in working folder',
    })
    expect(row).toHaveTextContent('Claude subagent · general-purpose')
    expect(row).toHaveTextContent('working')
    expect(screen.queryByText(/ls -la/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Async agent launched/)).not.toBeInTheDocument()

    // The parent's turn is over: Send, not Stop, and the message starts a turn.
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'Meanwhile, say hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'command.dispatch',
        expect.objectContaining({
          command: expect.objectContaining({ type: 'turn.start', text: 'Meanwhile, say hi' }),
        }),
      ),
    )
  })

  it('lists the subagent with the children, opens its own view, and goes back', async () => {
    renderView()
    await screen.findByRole('textbox', { name: 'Message' })
    parentTurnWithBackgroundSubagent()

    const rail = await screen.findByRole('button', { name: 'Child sessions' })
    expect(rail).toHaveTextContent('1 agent')
    expect(rail).toHaveTextContent('1 working')
    fireEvent.click(rail)
    const list = await screen.findByRole('list', { name: 'Child sessions' })
    expect(within(list).getByText('Claude subagent')).toBeInTheDocument()
    // Nothing of the parent's own turn runs, so the children's Stop is offered.
    fireEvent.click(screen.getByRole('button', { name: 'Stop all' }))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('session.stopChildren', { sessionId: 'sess_1' }),
    )
    fireEvent.click(within(list).getByRole('button', { name: /List files in working folder/ }))

    const view = await screen.findByRole('region', {
      name: 'Claude subagent: List files in working folder',
    })
    expect(within(view).getByText('List the files here.')).toBeInTheDocument()
    expect(
      within(view).getByText(/Claude subagent · general-purpose · claude-haiku-5-5/),
    ).toBeInTheDocument()
    expect(within(view).getByText('Message the parent to steer this subagent.')).toBeInTheDocument()
    expect(within(view).queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()

    // It updates live: the subagent's answer lands while the view is open.
    emit({
      type: 'background.task.parts.appended',
      taskId: AGENT_CALL,
      parts: [{ type: 'text', text: 'Two files: alpha.txt and beta.md.' }],
    })
    expect(await within(view).findByText('Two files: alpha.txt and beta.md.')).toBeInTheDocument()
    emit({
      type: 'background.task.updated',
      taskId: AGENT_CALL,
      kind: 'subagent',
      label: '',
      status: 'completed',
      result: 'Two files: alpha.txt and beta.md.',
    })
    await waitFor(() =>
      expect(within(view).getByRole('status', { name: 'Done' })).toBeInTheDocument(),
    )

    fireEvent.click(within(view).getByRole('button', { name: 'Open parent session: Parent chat' }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /Claude subagent: / })).not.toBeInTheDocument(),
    )
    const row = screen.getByRole('button', {
      name: 'Open Claude subagent: List files in working folder',
    })
    expect(row).toHaveTextContent('Two files: alpha.txt and beta.md.')
    // The parent row opens the same view.
    fireEvent.click(row)
    expect(
      await screen.findByRole('region', { name: 'Claude subagent: List files in working folder' }),
    ).toBeInTheDocument()
  })
})
