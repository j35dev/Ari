import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { ContextMeter, SessionView, contextTokensFromHint, formatCompactTokens, type SessionDefaults } from './SessionView'

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
