import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { useState } from 'react'
import { ToastProvider } from '@ari/ui/toast'
import {
  ContextMeter,
  PermissionModeChip,
  SessionView,
  contextTokensFromHint,
  formatCompactTokens,
  type SessionDefaults,
} from './SessionView'

// jsdom implements neither ResizeObserver nor element scrolling; TranscriptView's
// stick-to-bottom effect calls scrollTo during mount (same stubs as its own tests).
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {}
}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

const invokeMock = rpcMocks.invoke as unknown as Mock<
  (method: string, params?: unknown) => Promise<unknown>
>

const DEFAULTS: SessionDefaults = {
  driverKind: 'ari-core',
  modelId: null,
  permissionMode: 'ask',
}

const PROJECT = {
  id: 'proj_1',
  name: 'Demo',
  path: 'C:\\repos\\demo',
  colorIndex: 0,
  createdAt: 0,
}

const SESSION = {
  id: 'sess_1',
  projectId: PROJECT.id,
  title: 'Demo session',
  driverKind: 'ari-core',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
}

/** The live event listener registered by the session.events subscription. */
let sessionListener: ((payload: unknown) => void) | null = null

/** Simulates the main process's replay-then-live protocol on (re)subscribe. */
function emitReplayDone(): void {
  act(() => {
    sessionListener?.({ sessionId: 'sess_1', replayDone: true })
  })
}

function emitSessionEvent(event: Record<string, unknown>): void {
  act(() => {
    sessionListener?.({ sessionId: 'sess_1', event })
  })
}

function renderView(): void {
  render(
    <ToastProvider>
      <SessionView sessionId="sess_1" defaults={DEFAULTS} onDefaultsChange={() => undefined} />
    </ToastProvider>,
  )
}

describe('SessionView question panel', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return [PROJECT]
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  it('mounts QuestionPanel when an input.requested event arrives', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'input.requested',
      inputId: 'q1',
      prompt: 'Proceed with force push?',
      choicesJson: '["Yes","No"]',
    })

    expect(await screen.findByRole('region', { name: 'Agent question' })).toBeInTheDocument()
    expect(screen.getByText('Proceed with force push?')).toBeInTheDocument()
  })

  it('dispatches input.respond with the chosen option and clears the panel', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByLabelText('Message')

    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'input.requested',
      inputId: 'q1',
      prompt: 'Proceed with force push?',
      choicesJson: '["Yes","No"]',
    })
    await screen.findByRole('region', { name: 'Agent question' })

    await user.click(screen.getByRole('button', { name: /Yes/ }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('command.dispatch', {
        command: { type: 'input.respond', sessionId: 'sess_1', inputId: 'q1', value: 'Yes' },
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument()
    })
  })

  it('clears the panel when an input.responded event replays', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'input.requested',
      inputId: 'q1',
      prompt: 'Retry the failed step?',
      choicesJson: null,
    })
    await screen.findByRole('region', { name: 'Agent question' })

    emitSessionEvent({
      seq: 2,
      at: 2,
      sessionId: 'sess_1',
      type: 'input.responded',
      inputId: 'q1',
    })

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Agent question' })).not.toBeInTheDocument()
    })
  })
})

const TURN_DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

describe('SessionView edit and resend', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return []
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  function emitUserMessage(): void {
    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'user.message.added',
      message: {
        id: 'm1',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        role: 'user',
        parts: [{ type: 'text', text: 'please retry the build' }],
        createdAt: 1,
      },
    })
  }

  it('fills and focuses the composer when a user message edit fires', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByLabelText('Message')

    emitUserMessage()

    await user.click(await screen.findByRole('button', { name: 'Edit message' }))

    const input = screen.getByLabelText('Message')
    await waitFor(() => expect(input).toHaveValue('please retry the build'))
    expect(input).toHaveFocus()
  })

  it('sends an edited prompt as a new turn through the normal path', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByLabelText('Message')

    emitUserMessage()
    await user.click(await screen.findByRole('button', { name: 'Edit message' }))
    const input = await screen.findByLabelText('Message')
    await waitFor(() => expect(input).toHaveValue('please retry the build'))

    await user.type(input, ', verbose{Enter}')

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('command.dispatch', {
        command: { type: 'turn.start', sessionId: 'sess_1', text: 'please retry the build, verbose' },
      })
    })
  })
})

describe('SessionView regenerate and retry', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return []
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      if (method === 'git.turnDiff') return { diffText: null }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  function emitTurn(
    stopReason: 'completed' | 'error',
    errorMessage: string | null,
  ): void {
    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'user.message.added',
      message: {
        id: 'm1',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        role: 'user',
        parts: [{ type: 'text', text: 'run the test suite' }],
        createdAt: 1,
      },
    })
    emitSessionEvent({ seq: 2, at: 2, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_1' })
    emitSessionEvent({
      seq: 3,
      at: 3,
      sessionId: 'sess_1',
      type: 'assistant.parts.appended',
      messageId: 'm2',
      parts: [{ type: 'text', text: 'Working…' }],
    })
    emitSessionEvent({
      seq: 4,
      at: 4,
      sessionId: 'sess_1',
      type: 'turn.settled',
      turnId: 'turn_1',
      stopReason,
      errorMessage,
    })
  }

  it('offers regenerate after a settled turn and resends the last user prompt', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByLabelText('Message')

    emitTurn('completed', null)
    invokeMock.mockClear()

    const button = await screen.findByRole('button', { name: 'Regenerate response' })
    expect(button).toBeEnabled()
    await user.click(button)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('command.dispatch', {
        command: { type: 'turn.start', sessionId: 'sess_1', text: 'run the test suite' },
      })
    })
  })

  it('disables regenerate while a turn is running and enables it on settle', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'user.message.added',
      message: {
        id: 'm1',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        role: 'user',
        parts: [{ type: 'text', text: 'run the test suite' }],
        createdAt: 1,
      },
    })
    emitSessionEvent({ seq: 2, at: 2, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_1' })
    emitSessionEvent({
      seq: 3,
      at: 3,
      sessionId: 'sess_1',
      type: 'assistant.parts.appended',
      messageId: 'm2',
      parts: [{ type: 'text', text: 'Streaming…' }],
    })

    expect(await screen.findByRole('button', { name: 'Regenerate response' })).toBeDisabled()

    emitSessionEvent({
      seq: 4,
      at: 4,
      sessionId: 'sess_1',
      type: 'turn.settled',
      turnId: 'turn_1',
      stopReason: 'completed',
      errorMessage: null,
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
    })
  })

  it('shows retry on settle error and resends the last prompt as a new turn', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByLabelText('Message')

    emitTurn('error', 'provider exploded')
    expect(await screen.findByRole('alert')).toHaveTextContent('provider exploded')

    invokeMock.mockClear()
    await user.click(screen.getByRole('button', { name: 'Retry last message' }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('command.dispatch', {
        command: { type: 'turn.start', sessionId: 'sess_1', text: 'run the test suite' },
      })
    })
  })

  it('hides the retry control when the failed turn has no user prompt to resend', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitSessionEvent({ seq: 1, at: 1, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_9' })
    emitSessionEvent({
      seq: 2,
      at: 2,
      sessionId: 'sess_1',
      type: 'turn.settled',
      turnId: 'turn_9',
      stopReason: 'error',
      errorMessage: 'no prompt ever sent',
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('no prompt ever sent')
    expect(screen.queryByRole('button', { name: 'Retry last message' })).not.toBeInTheDocument()
  })
})

describe('SessionView per-turn diff cards', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method, params) => {
      if (method === 'project.list') return [PROJECT]
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      if (method === 'git.turnDiff') {
        const p = params as { turnId: string }
        return p.turnId === 'turn_1' ? { diffText: TURN_DIFF } : { diffText: null }
      }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  function replaySettledTurn(): void {
    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'user.message.added',
      message: {
        id: 'm1',
        sessionId: 'sess_1',
        turnId: 'turn_1',
        role: 'user',
        parts: [{ type: 'text', text: 'edit the file' }],
        createdAt: 1,
      },
    })
    emitSessionEvent({ seq: 2, at: 2, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_1' })
    emitSessionEvent({
      seq: 3,
      at: 3,
      sessionId: 'sess_1',
      type: 'assistant.parts.appended',
      messageId: 'm2',
      parts: [{ type: 'text', text: 'Done.' }],
    })
    emitSessionEvent({
      seq: 4,
      at: 4,
      sessionId: 'sess_1',
      type: 'turn.settled',
      turnId: 'turn_1',
      stopReason: 'completed',
      errorMessage: null,
    })
  }

  it('queries git.turnDiff after settle and shows a collapsed card', async () => {
    renderView()
    await screen.findByLabelText('Message')

    replaySettledTurn()

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('git.turnDiff', {
        path: PROJECT.path,
        sessionId: 'sess_1',
        turnId: 'turn_1',
      })
    })
    expect(await screen.findByRole('button', { name: 'Turn diff: 1 file changed' })).toBeInTheDocument()
  })

  it('shows no card when the settled turn has a null diff', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitSessionEvent({ seq: 1, at: 1, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_2' })
    emitSessionEvent({
      seq: 2,
      at: 2,
      sessionId: 'sess_1',
      type: 'assistant.parts.appended',
      messageId: 'm2',
      parts: [{ type: 'text', text: 'No edits here.' }],
    })
    emitSessionEvent({
      seq: 3,
      at: 3,
      sessionId: 'sess_1',
      type: 'turn.settled',
      turnId: 'turn_2',
      stopReason: 'completed',
      errorMessage: null,
    })

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'git.turnDiff',
        expect.objectContaining({ turnId: 'turn_2' }),
      )
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Turn diff/ })).not.toBeInTheDocument()
    })
  })
})

describe('SessionView context meter', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return []
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  function emitUsage(): void {
    emitSessionEvent({ seq: 1, at: 1, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_1' })
    emitSessionEvent({
      seq: 2,
      at: 2,
      sessionId: 'sess_1',
      type: 'usage.recorded',
      inputTokens: 100,
      outputTokens: 50,
    })
  }

  it('renders the used token count when usage is present', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitUsage()

    expect(await screen.findByTitle('Total tokens: 150')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument()
  })

  it('omits the denominator when the catalog has no context hint', async () => {
    renderView()
    await screen.findByLabelText('Message')

    emitUsage()

    expect(screen.getByText('150')).toBeInTheDocument()
    expect(screen.queryByText(/\/.+/)).not.toBeInTheDocument()
  })

  it('shows used / window when the session model carries a context hint', async () => {
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return []
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') {
        return [
          {
            kind: 'claude',
            source: 'static',
            models: [{ id: 'sonar-x', label: 'Sonar X', contextHint: '200k' }],
          },
        ]
      }
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    render(
      <ToastProvider>
        <SessionView
          sessionId="sess_1"
          defaults={{ driverKind: 'claude', modelId: 'sonar-x', permissionMode: 'ask' }}
          onDefaultsChange={() => undefined}
        />
      </ToastProvider>,
    )
    await screen.findByLabelText('Message')

    emitSessionEvent({ seq: 1, at: 1, sessionId: 'sess_1', type: 'turn.started', turnId: 'turn_1' })
    emitSessionEvent({
      seq: 2,
      at: 2,
      sessionId: 'sess_1',
      type: 'usage.recorded',
      inputTokens: 100_000,
      outputTokens: 5_000,
    })

    expect(await screen.findByText('105K / 200K')).toBeInTheDocument()
  })
})

describe('context meter helpers', () => {
  it('parses catalog context hints into token counts', () => {
    expect(contextTokensFromHint('200k')).toBe(200_000)
    expect(contextTokensFromHint('1M')).toBe(1_000_000)
    expect(contextTokensFromHint('32768')).toBe(32768)
    expect(contextTokensFromHint('128 K')).toBe(128_000)
    expect(contextTokensFromHint('soon')).toBeNull()
    expect(contextTokensFromHint(undefined)).toBeNull()
  })

  it('formats compact token counts', () => {
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(12_500)).toBe('12.5K')
    expect(formatCompactTokens(200_000)).toBe('200K')
    expect(formatCompactTokens(1_000_000)).toBe('1M')
  })

  it('renders a numeric-only chip without a window and a full chip with one', () => {
    const { container: bare } = render(<ContextMeter used={42} contextWindow={null} />)
    expect(bare.textContent).toBe('42')
    const { container } = render(<ContextMeter used={50_000} contextWindow={200_000} />)
    expect(container.textContent).toContain('50K / 200K')
    expect(container.querySelector('[aria-hidden]')).not.toBeNull()
  })
})

describe('SessionView replay/live dedupe (M23.12)', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return [PROJECT]
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  const userMessage = (seq: number, text: string): Record<string, unknown> => ({
    seq,
    at: seq,
    sessionId: 'sess_1',
    type: 'user.message.added',
    message: {
      id: `m${seq}`,
      sessionId: 'sess_1',
      turnId: 'turn_1',
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: seq,
    },
  })

  function emitFrame(payload: Record<string, unknown>): void {
    act(() => {
      sessionListener?.({ sessionId: 'sess_1', ...payload })
    })
  }

  it('does not double-render when the replay burst re-delivers live seqs', async () => {
    renderView()
    await screen.findByLabelText('Message')

    // Mid-turn resubscribe: live events arrive while the journal is read.
    emitFrame({ event: userMessage(1, 'who are you') })
    emitFrame({
      event: {
        seq: 2, at: 2, sessionId: 'sess_1', type: 'assistant.parts.appended',
        messageId: 'm2', parts: [{ type: 'text', text: 'I am the agent.' }],
      },
    })

    // Replay burst arrives afterwards, covering seq 1-2 again, then the sentinel.
    emitFrame({ event: userMessage(1, 'who are you'), replay: true })
    emitFrame({
      event: {
        seq: 2, at: 2, sessionId: 'sess_1', type: 'assistant.parts.appended',
        messageId: 'm2', parts: [{ type: 'text', text: 'I am the agent.' }],
      },
      replay: true,
    })
    emitFrame({ replayDone: true })

    // Exactly one copy of each message survives.
    expect(await screen.findByText('who are you')).toBeInTheDocument()
    expect(screen.getAllByText('who are you')).toHaveLength(1)
    expect(screen.getAllByText('I am the agent.')).toHaveLength(1)
  })

  it('holds live frames until the replay sentinel so history stays in order', async () => {
    renderView()
    await screen.findByLabelText('Message')

    // Live seq 2 lands before the replayed seq 1.
    emitFrame({ event: userMessage(2, 'second') })
    emitFrame({ event: userMessage(1, 'first'), replay: true })
    emitFrame({ replayDone: true })

    const first = await screen.findByText('first')
    const second = screen.getByText('second')
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('SessionView queued messages', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return [PROJECT]
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  function startTurn(): void {
    emitSessionEvent({
      seq: 1,
      at: 1,
      sessionId: 'sess_1',
      type: 'turn.started',
      turnId: 'turn_1',
    })
  }

  it('mirrors the queue from enqueued/dequeued events and never self-dispatches', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByLabelText('Message')
    startTurn()

    await user.type(screen.getByLabelText('Message'), 'second prompt{Enter}')
    expect(invokeMock).toHaveBeenCalledWith('command.dispatch', {
      command: { type: 'message.enqueue', sessionId: 'sess_1', text: 'second prompt' },
    })

    emitSessionEvent({
      seq: 2,
      at: 2,
      sessionId: 'sess_1',
      type: 'message.enqueued',
      text: 'second prompt',
    })
    expect(await screen.findByText(/1 queued message/)).toBeInTheDocument()

    // Settle must NOT dispatch a follow-up turn � the engine owns continuation.
    invokeMock.mockClear()
    emitSessionEvent({
      seq: 3,
      at: 3,
      sessionId: 'sess_1',
      type: 'usage.recorded',
      inputTokens: 1,
      outputTokens: 1,
    })
    emitSessionEvent({
      seq: 4,
      at: 4,
      sessionId: 'sess_1',
      type: 'turn.settled',
      turnId: 'turn_1',
      stopReason: 'completed',
      errorMessage: null,
    })
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.some(([method]) => method === 'command.dispatch'),
      ).toBe(false)
    })

    // Engine dequeues the next message; a fresh turn begins.
    emitSessionEvent({
      seq: 5,
      at: 5,
      sessionId: 'sess_1',
      type: 'message.dequeued',
      text: 'second prompt',
    })
    await waitFor(() => {
      expect(screen.queryByText(/queued message/)).not.toBeInTheDocument()
    })
  })
})

describe('PermissionModeChip', () => {
  it('opens a listbox and reports the chosen mode', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PermissionModeChip mode="ask" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Permission mode: Ask' }))
    const listbox = screen.getByRole('listbox', { name: 'Permission mode' })
    expect(listbox).toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: /Full auto/ }))
    expect(onChange).toHaveBeenCalledWith('full')
  })
})

/**
 * Regression: changing the permission mode used to publish a defaults object
 * captured before the last model pick, so the model chip snapped back to the
 * detected CLI default the moment the user switched modes.
 */
describe('SessionView mode change preserves the picked model', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (method) => {
      if (method === 'project.list') return [PROJECT]
      if (method === 'files.index') return { paths: [] }
      if (method === 'session.load') return { session: { ...SESSION }, activeTurnId: null }
      if (method === 'providers.detect') return []
      if (method === 'providers.models') return []
      if (method === 'endpoints.list') return []
      if (method === 'command.dispatch') return { accepted: true }
      throw new Error(`unexpected method: ${String(method)}`)
    })
    rpcMocks.subscribe.mockImplementation(
      (_name: string, _params: unknown, onEvent: (payload: unknown) => void) => {
        sessionListener = onEvent
        emitReplayDone()
        return () => undefined
      },
    )
  })

  afterEach(() => {
    sessionListener = null
    vi.clearAllMocks()
  })

  it('keeps driverKind and modelId when the mode chip changes', async () => {
    /** Mirrors App.tsx: the parent owns `defaults` and feeds them straight back. */
    function Host() {
      const [defaults, setDefaults] = useState<SessionDefaults>(DEFAULTS)
      return (
        <ToastProvider>
          <button
            type="button"
            onClick={() =>
              setDefaults((prev) => ({ ...prev, driverKind: 'opencode', modelId: 'gpt-5' }))
            }
          >
            pick model
          </button>
          <span data-testid="defaults">
            {`${defaults.driverKind}|${defaults.modelId ?? 'none'}|${defaults.permissionMode}`}
          </span>
          <SessionView sessionId="sess_1" defaults={defaults} onDefaultsChange={setDefaults} />
        </ToastProvider>
      )
    }

    const user = userEvent.setup()
    render(<Host />)
    await screen.findByLabelText('Message')
    // session.load pushes the persisted defaults up on mount; let that settle.
    await waitFor(() => {
      expect(screen.getByTestId('defaults').textContent).toBe('ari-core|none|ask')
    })

    await user.click(screen.getByRole('button', { name: 'pick model' }))
    expect(screen.getByTestId('defaults').textContent).toBe('opencode|gpt-5|ask')

    await user.click(screen.getByRole('button', { name: 'Permission mode: Ask' }))
    await user.click(screen.getByRole('option', { name: /Full auto/ }))

    expect(screen.getByTestId('defaults').textContent).toBe('opencode|gpt-5|full')
  })
})
