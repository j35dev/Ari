import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { ToastProvider } from '@ari/ui/toast'
import { SessionView, type SessionDefaults } from './SessionView'

const rpc = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc }))
const sounds = vi.hoisted(() => ({ playSettleSound: vi.fn() }))
vi.mock('../moment/settle-sound', () => sounds)

Element.prototype.scrollTo = () => {}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect

const defaults: SessionDefaults = {
  driverKind: 'ari-core',
  modelId: null,
  effort: null,
  permissionMode: 'ask',
}
const attempts: {
  id: string
  listener: (frame: SessionEventFrame) => void
  stop: ReturnType<typeof vi.fn>
}[] = []
let sessionId: string
let nextId = 0
let metadataFails = false

function message(seq: number, text: string, id = sessionId): JournalEvent {
  return {
    seq,
    at: seq,
    sessionId: id,
    type: 'user.message.added',
    message: {
      id: `${id}_${seq}`,
      sessionId: id,
      turnId: null,
      role: 'user',
      createdAt: seq,
      parts: [{ type: 'text', text }],
    },
  }
}
function emit(frame: Omit<SessionEventFrame, 'sessionId'>, attempt = attempts.at(-1)!): void {
  act(() => attempt.listener({ sessionId: attempt.id, ...frame }))
}
function view(id = sessionId) {
  return (
    <ToastProvider>
      <SessionView sessionId={id} defaults={defaults} onDefaultsChange={() => {}} />
    </ToastProvider>
  )
}
function texts(): string[] {
  return ['first saved', 'missing saved', 'live after failure', 'live during retry']
}

beforeEach(() => {
  sessionId = `sess_history_${++nextId}`
  metadataFails = false
  attempts.length = 0
  localStorage.clear()
  rpc.invoke.mockReset()
  rpc.invoke.mockImplementation(async (method: string, params?: { sessionId?: string }) => {
    if (method === 'settings.get') return { notifications: { settleSound: true }, appearance: {} }
    if (method === 'session.load') {
      if (metadataFails) throw new Error('metadata unavailable')
      return {
        session: { id: params?.sessionId, title: 'History test', ...defaults },
        activeTurnId: null,
      }
    }
    if (method === 'files.index') return { paths: [] }
    if (method === 'git.status') return { branch: null, files: [] }
    if (
      method === 'project.list' ||
      method === 'providers.models' ||
      method === 'providers.detect' ||
      method === 'endpoints.list'
    )
      return []
    if (method === 'session.workspace') return { path: null }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  rpc.subscribe.mockReset()
  rpc.subscribe.mockImplementation(
    (name: string, params: { sessionId: string }, listener: (frame: SessionEventFrame) => void) => {
      const stop = vi.fn()
      if (name === 'session.events') attempts.push({ id: params.sessionId, listener, stop })
      return stop
    },
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SessionView history recovery', () => {
  it.each([false, true])(
    'shows incomplete history and preserves ordered live events through retry (partial: %s)',
    async (partial) => {
      render(view())
      const editor = await screen.findByLabelText('Message')
      fireEvent.change(editor, { target: { value: 'unsent draft' } })
      const image = new File(['image'], 'draft.png', { type: 'image/png' })
      fireEvent.paste(editor, {
        clipboardData: { files: Object.assign([image], { item: () => image }) },
      })
      expect(await screen.findByRole('button', { name: 'Remove draft.png' })).toBeVisible()
      const old = attempts.at(-1)!
      emit({ event: message(3, 'live after failure') })
      if (partial) emit({ replay: true, events: [message(1, 'first saved')] })
      emit({ replayDone: true, replayOutcome: 'incomplete' } as Omit<
        SessionEventFrame,
        'sessionId'
      >)
      expect(
        await screen.findByText('History is incomplete. Some saved messages could not be loaded.'),
      ).toBeVisible()
      expect(await screen.findByText('live after failure')).toBeVisible()
      expect(screen.queryByRole('heading', { name: 'Make room for your next idea.' })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
      expect(attempts).toHaveLength(2)
      expect(old.stop).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Retrying history…' })).toBeDisabled()
      expect(screen.getByText('live after failure')).toBeVisible()
      // Late terminal and chunk from the previous generation must do nothing.
      emit({ replayDone: true }, old)
      emit({ replay: true, events: [message(99, 'stale message')] }, old)
      expect(screen.queryByText('stale message')).toBeNull()
      expect(screen.getByRole('button', { name: 'Retrying history…' })).toBeDisabled()

      emit({ event: message(4, 'live during retry') })
      // The old live source bridges async subscription IPC until the new terminal.
      emit({ event: message(4, 'live during retry') }, old)
      emit({ event: message(5, 'bridged live event') }, old)
      emit({
        replay: true,
        events: [
          message(1, 'first saved'),
          message(2, 'missing saved'),
          message(3, 'live after failure'),
        ],
      })
      emit({ replayDone: true, replayOutcome: 'complete' } as Omit<SessionEventFrame, 'sessionId'>)
      expect(old.stop).toHaveBeenCalledOnce()
      await waitFor(() =>
        expect(
          screen.queryByText('History is incomplete. Some saved messages could not be loaded.'),
        ).toBeNull(),
      )
      const nodes = texts().map((text) => screen.getByText(text))
      for (let i = 0; i < nodes.length - 1; i++)
        expect(
          nodes[i]!.compareDocumentPosition(nodes[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
      for (const text of texts()) expect(screen.getAllByText(text)).toHaveLength(1)
      const bridged = screen.getByText('bridged live event')
      expect(
        nodes.at(-1)!.compareDocumentPosition(bridged) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      emit({ event: message(5, 'bridged live event') })
      expect(screen.getAllByText('bridged live event')).toHaveLength(1)
      emit(
        { replayDone: true, replayOutcome: 'incomplete' } as Omit<SessionEventFrame, 'sessionId'>,
        old,
      )
      emit({ event: message(100, 'retired live frame') }, old)
      expect(screen.queryByText('retired live frame')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry history' })).toBeNull()
      expect(screen.getByLabelText('Message')).toBe(editor)
      expect(editor).toHaveValue('unsent draft')
      expect(screen.getByRole('button', { name: 'Remove draft.png' })).toBeVisible()
      expect(sounds.playSettleSound).not.toHaveBeenCalled()
      expect(rpc.invoke.mock.calls.filter(([method]) => method === 'session.load')).toHaveLength(1)
    },
  )

  it('clears an older failure when retry recovers a completed turn', async () => {
    render(view())
    await screen.findByLabelText('Message')
    emit({
      replay: true,
      events: [
        { seq: 1, at: 1, sessionId, type: 'turn.started', turnId: 'old' },
        {
          seq: 2,
          at: 2,
          sessionId,
          type: 'turn.settled',
          turnId: 'old',
          stopReason: 'error',
          errorMessage: 'Old failure',
        },
      ],
    })
    emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: null })
    expect(screen.getByRole('alert')).toHaveTextContent('Old failure')
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    emit({
      replay: true,
      events: [
        { seq: 3, at: 3, sessionId, type: 'turn.started', turnId: 'new' },
        {
          seq: 4,
          at: 4,
          sessionId,
          type: 'turn.settled',
          turnId: 'new',
          stopReason: 'completed',
          errorMessage: null,
        },
      ],
    })
    emit({ replayDone: true, replayOutcome: 'complete', liveTurnId: null })
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).toBeNull()
    expect(sounds.playSettleSound).not.toHaveBeenCalled()
  })

  it('shows a failure settlement recovered by history retry without replaying its chime', async () => {
    render(view())
    await screen.findByLabelText('Message')
    emit({
      replay: true,
      events: [{ seq: 1, at: 1, sessionId, type: 'turn.started', turnId: 'failed' }],
    })
    emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: null })
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    emit({
      replay: true,
      events: [
        {
          seq: 2,
          at: 2,
          sessionId,
          type: 'turn.settled',
          turnId: 'failed',
          stopReason: 'error',
          errorMessage: 'Recovered failure',
        },
      ],
    })
    emit({ replayDone: true, replayOutcome: 'complete', liveTurnId: null })
    expect(screen.getByRole('alert')).toHaveTextContent('Recovered failure')
    expect(sounds.playSettleSound).not.toHaveBeenCalled()
  })

  it('keeps a dismissed failure dismissed when retry recovers the same outcome', async () => {
    render(view())
    await screen.findByLabelText('Message')
    const events: JournalEvent[] = [
      { seq: 1, at: 1, sessionId, type: 'turn.started', turnId: 'dismissed' },
      {
        seq: 2,
        at: 2,
        sessionId,
        type: 'turn.settled',
        turnId: 'dismissed',
        stopReason: 'error',
        errorMessage: 'Dismissed failure',
      },
    ]
    emit({ replay: true, events })
    emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: null })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    emit({ replay: true, events })
    emit({ replayDone: true, replayOutcome: 'complete', liveTurnId: null })
    expect(screen.queryByRole('button', { name: 'Dismiss error' })).toBeNull()
  })

  it('loads the diff for a settled turn recovered by history retry when it enters view', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const fallback = rpc.invoke.getMockImplementation()!
    rpc.invoke.mockImplementation(async (method: string, params) => {
      if (method === 'git.turnDiff') return { diffText: null }
      return fallback(method, params)
    })
    try {
      const rendered = render(view())
      await screen.findByLabelText('Message')
      emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: null })
      fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
      emit({
        replay: true,
        events: [
          { seq: 1, at: 1, sessionId, type: 'turn.started', turnId: 'recovered-turn' },
          {
            seq: 2,
            at: 2,
            sessionId,
            type: 'user.message.added',
            message: {
              id: 'recovered-prompt',
              sessionId,
              turnId: 'recovered-turn',
              role: 'user',
              createdAt: 2,
              parts: [{ type: 'text', text: 'Recovered change request' }],
            },
          },
          {
            seq: 3,
            at: 3,
            sessionId,
            type: 'assistant.parts.appended',
            messageId: 'recovered-response',
            parts: [{ type: 'text', text: 'Recovered work completed' }],
          },
          {
            seq: 4,
            at: 4,
            sessionId,
            type: 'turn.settled',
            turnId: 'recovered-turn',
            stopReason: 'completed',
            errorMessage: null,
          },
        ],
      })
      emit({ replayDone: true, replayOutcome: 'complete', liveTurnId: null })
      expect(await screen.findByText('Recovered work completed')).toBeVisible()
      await waitFor(() =>
        expect(rpc.invoke).toHaveBeenCalledWith('git.turnDiff', {
          sessionId,
          turnId: 'recovered-turn',
        }),
      )
      rendered.unmount()
      rpc.invoke.mockClear()
      render(view())
      await screen.findByLabelText('Message')
      emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: null })
      expect(await screen.findByText('Recovered work completed')).toBeVisible()
      await waitFor(() =>
        expect(rpc.invoke).toHaveBeenCalledWith('git.turnDiff', {
          sessionId,
          turnId: 'recovered-turn',
        }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps metadata failure distinct and retries metadata without resetting the conversation', async () => {
    metadataFails = true
    render(view())
    const editor = await screen.findByLabelText('Message')
    fireEvent.change(editor, { target: { value: 'keep draft' } })
    emit({ replay: true, events: [message(1, 'saved message')] })
    emit({ replayDone: true }) // compatibility with an older main process
    expect(await screen.findByText('Session details could not be loaded.')).toBeVisible()
    expect(screen.queryByText(/History is incomplete/)).toBeNull()
    metadataFails = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry session details' }))
    await waitFor(() =>
      expect(screen.queryByText('Session details could not be loaded.')).toBeNull(),
    )
    expect(attempts).toHaveLength(1)
    expect(screen.getByText('saved message')).toBeVisible()
    expect(screen.getByLabelText('Message')).toBe(editor)
    expect(editor).toHaveValue('keep draft')
  })

  it('merges missing assistant deltas before retained live deltas without duplicating either', async () => {
    render(view())
    await screen.findByLabelText('Message')
    const delta = (seq: number, text: string): JournalEvent => ({
      seq,
      at: seq,
      sessionId,
      type: 'assistant.parts.appended',
      messageId: 'answer',
      parts: [{ type: 'text', text }],
    })
    emit({ replay: true, events: [message(1, 'question')] })
    emit({ event: delta(4, 'live tail') })
    emit({ replayDone: true, replayOutcome: 'incomplete' })
    expect(await screen.findByText('live tail')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    emit({ event: delta(5, ' newest') })
    emit({
      replay: true,
      events: [
        message(1, 'question'),
        delta(2, 'saved '),
        delta(3, 'middle '),
        delta(4, 'live tail'),
      ],
    })
    emit({ replayDone: true, replayOutcome: 'complete' })
    expect(await screen.findByText('saved middle live tail newest')).toBeVisible()
    expect(screen.getAllByText('saved middle live tail newest')).toHaveLength(1)
  })

  it('keeps a newer live request and queue state when retry fills older control events', async () => {
    render(view())
    await screen.findByLabelText('Message')
    emit({ event: { seq: 4, at: 4, sessionId, type: 'turn.started', turnId: 'current' } })
    emit({
      event: {
        seq: 5,
        at: 5,
        sessionId,
        type: 'input.requested',
        inputId: 'current-input',
        prompt: 'Current question?',
        choicesJson: null,
      },
    })
    emit({
      event: {
        seq: 6,
        at: 6,
        sessionId,
        type: 'message.dequeued',
        text: 'already consumed',
        attachments: [],
      },
    })
    emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: 'current' })
    expect(await screen.findByText('Current question?')).toBeVisible()
    sounds.playSettleSound.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    emit({
      replay: true,
      events: [
        { seq: 1, at: 1, sessionId, type: 'turn.started', turnId: 'old' },
        {
          seq: 2,
          at: 2,
          sessionId,
          type: 'input.requested',
          inputId: 'old-input',
          prompt: 'Old question?',
          choicesJson: null,
        },
        {
          seq: 3,
          at: 3,
          sessionId,
          type: 'message.enqueued',
          text: 'already consumed',
          attachments: [],
        },
      ],
    })
    expect(screen.getByText('Current question?')).toBeVisible()
    emit({ replayDone: true, replayOutcome: 'complete', liveTurnId: 'current' })
    expect(screen.getByText('Current question?')).toBeVisible()
    expect(screen.queryByText('Old question?')).toBeNull()
    expect(screen.queryByText('already consumed')).toBeNull()
    expect(screen.getByRole('img', { name: 'Agent working' })).toBeVisible()
    expect(sounds.playSettleSound).not.toHaveBeenCalled()
  })

  it('does not turn old journal execution or metadata into a live turn', async () => {
    const fallback = rpc.invoke.getMockImplementation()!
    rpc.invoke.mockImplementation(async (method: string, params) => {
      if (method === 'session.load')
        return { session: { title: 'Old session', ...defaults }, activeTurnId: 'old' }
      return fallback(method, params)
    })
    render(view())
    await screen.findByLabelText('Message')
    emit({
      replay: true,
      events: [
        { seq: 1, at: 1, sessionId, type: 'turn.started', turnId: 'old' },
        {
          seq: 2,
          at: 2,
          sessionId,
          type: 'input.requested',
          inputId: 'old',
          prompt: 'Abandoned question?',
          choicesJson: null,
        },
      ],
    })
    expect(screen.queryByRole('img', { name: 'Agent working' })).toBeNull()
    expect(screen.queryByText('Abandoned question?')).toBeNull()
    emit({ replayDone: true, replayOutcome: 'incomplete', liveTurnId: null })
    await act(async () => {})
    expect(screen.queryByRole('img', { name: 'Agent working' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByText('Abandoned question?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeVisible()
  })

  it('leaves repeated read failures on explicit retry instead of looping disk reads', async () => {
    render(view())
    await screen.findByLabelText('Message')
    emit({ replayDone: true, replayOutcome: 'incomplete' })
    await act(async () => {})
    expect(attempts).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
    expect(attempts).toHaveLength(2)
    emit({ replayDone: true, replayOutcome: 'incomplete' })
    await act(async () => {})
    expect(attempts).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled()
  })

  it('isolates session switches and keeps cached history on a later failed read', async () => {
    const firstId = sessionId
    const rendered = render(view())
    await screen.findByLabelText('Message')
    emit({ replay: true, events: [message(1, 'cached first')] })
    emit({ replayDone: true })
    const first = attempts.at(-1)!
    sessionId = `sess_history_${++nextId}`
    rendered.rerender(view())
    emit({ replay: true, events: [message(1, 'second session')] })
    emit({ replayDone: true })
    emit(
      { replayDone: true, replayOutcome: 'incomplete' } as Omit<SessionEventFrame, 'sessionId'>,
      first,
    )
    emit({ event: message(9, 'wrong session', firstId) }, first)
    expect(await screen.findByText('second session')).toBeVisible()
    expect(screen.queryByText('cached first')).toBeNull()
    expect(screen.queryByText('wrong session')).toBeNull()
    rendered.rerender(view(firstId))
    emit({ replayDone: true, replayOutcome: 'incomplete' } as Omit<SessionEventFrame, 'sessionId'>)
    expect(await screen.findByText('cached first')).toBeVisible()
    expect(screen.queryByText('second session')).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeVisible()
  })
})
