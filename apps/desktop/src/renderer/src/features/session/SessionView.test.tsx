import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import { SessionView, type SessionDefaults } from './SessionView'

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

const SESSION = {
  id: 'sess_1',
  projectId: 'adhoc',
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
      if (method === 'project.list') return []
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
