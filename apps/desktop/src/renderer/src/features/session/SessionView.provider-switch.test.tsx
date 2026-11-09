import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { ToastProvider } from '@ari/ui/toast'
import type { JournalEvent } from '@ari/contracts/events'
import { SessionView, type SessionDefaults } from './SessionView'

const rpcMocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function setup(
  projectId: string,
  accepted = true,
  evidence: 'history' | 'message' | 'ref' | 'running' | 'empty' = 'history',
  lead = false,
) {
  const onPick = vi.fn()
  const session = {
    id: 'aria',
    projectId,
    ...(lead ? { lead: true, createdBy: { kind: 'session' as const, sessionId: 'helm' } } : {}),
    title: 'Chat',
    driverKind: 'opencode' as const,
    modelId: 'current-model',
    effort: 'high',
    permissionMode: 'ask' as const,
    status: 'idle' as const,
    createdAt: 0,
    updatedAt: 0,
  }
  let listener: ((payload: unknown) => void) | undefined
  rpcMocks.invoke.mockImplementation(async (method: string) => {
    if (method === 'session.load')
      return {
        session,
        activeTurnId: evidence === 'running' ? 'first' : null,
        providerSessionId: evidence === 'ref' ? 'native' : null,
      }
    if (method === 'files.index') return { paths: [] }
    if (method === 'speech.status') return { engine: 'missing', model: null, ready: false }
    if (method === 'providers.detect')
      return ['opencode', 'claude'].map((kind) => ({
        kind,
        installed: true,
        binaryPath: kind,
        authStatus: 'authenticated',
        version: '1',
      }))
    if (method === 'providers.models')
      return [
        {
          kind: 'opencode',
          source: 'live',
          models: [
            { id: 'current-model', label: 'Current model' },
            { id: 'other-model', label: 'Other model' },
          ],
        },
        { kind: 'claude', source: 'live', models: [{ id: 'opus', label: 'Opus' }] },
      ]
    if (method === 'providers.efforts') return []
    if (method === 'endpoints.list' || method === 'session.tasks') return []
    if (method === 'command.dispatch')
      return { accepted, reason: accepted ? undefined : 'Switch refused' }
    return null
  })
  rpcMocks.subscribe.mockImplementation(
    (method: string, _params: unknown, onEvent: (payload: unknown) => void) => {
      if (method === 'session.events') {
        listener = onEvent
        const stamp = { at: 1, sessionId: 'aria' }
        const events = [
          { ...stamp, seq: 0, type: 'session.created', session },
          { ...stamp, seq: 1, type: 'turn.started', turnId: 'first' },
          {
            ...stamp,
            seq: 2,
            type: 'user.message.added',
            message: {
              id: 'user',
              sessionId: 'aria',
              turnId: 'first',
              role: 'user',
              parts: [{ type: 'text', text: 'Earlier request' }],
              createdAt: 1,
            },
          },
          {
            ...stamp,
            seq: 3,
            type: 'assistant.parts.appended',
            messageId: 'reply',
            parts: [{ type: 'text', text: 'Earlier reply' }],
          },
          {
            ...stamp,
            seq: 4,
            type: 'turn.settled',
            turnId: 'first',
            stopReason: 'completed',
            errorMessage: null,
          },
        ]
        const replay =
          evidence === 'history'
            ? events
            : evidence === 'message'
              ? events.filter((event) => !event.type.startsWith('turn.'))
              : evidence === 'running'
                ? events.slice(0, 2)
                : events.slice(0, 1)
        onEvent({ sessionId: 'aria', replay: true, events: replay })
        onEvent({ sessionId: 'aria', replayDone: true })
      }
      return () => undefined
    },
  )
  function Host() {
    const [defaults, setDefaults] = useState<SessionDefaults>({
      driverKind: session.driverKind,
      modelId: session.modelId,
      effort: session.effort,
      permissionMode: session.permissionMode,
    })
    return (
      <ToastProvider>
        <SessionView
          sessionId="aria"
          defaults={defaults}
          onDefaultsChange={setDefaults}
          onPick={onPick}
        />
      </ToastProvider>
    )
  }
  render(<Host />)
  return {
    onPick,
    emit: (event: JournalEvent) => act(() => listener?.({ sessionId: 'aria', event })),
  }
}

describe('Aria model picker', () => {
  it('uses a plain session update for an initial Aria provider choice', async () => {
    setup('helm', true, 'empty')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Claude'),
    )
    await user.click(within(screen.getByRole('listbox', { name: 'Models' })).getByText('Opus'))
    expect(rpcMocks.invoke).toHaveBeenCalledWith('command.dispatch', {
      command: {
        type: 'session.update',
        sessionId: 'aria',
        driverKind: 'claude',
        modelId: 'opus',
        effort: null,
      },
    })
    expect(screen.queryByRole('separator')).toBeNull()
  })
  it.each(['message', 'ref', 'running'] as const)(
    'locks ordinary provider selection with %s context even without settled turns',
    async (evidence) => {
      setup('project', true, evidence)
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
      expect(screen.queryByRole('presentation', { name: 'Providers' })).toBeNull()
      expect(screen.queryByText('Opus')).toBeNull()
    },
  )

  it('updates ordinary model chips while the dispatch response is still pending', async () => {
    const { onPick } = setup('project')
    const implementation = rpcMocks.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'command.dispatch'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : implementation(method, params),
    )
    const user = userEvent.setup()
    await screen.findByText('Earlier reply')
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('listbox', { name: 'Models' })).getByText('Other model'),
    )
    expect(screen.getByRole('button', { name: /Model: OpenCode · Other model/ })).toBeVisible()
    expect(onPick).not.toHaveBeenCalled()
    await act(async () => finish({ accepted: true }))
    expect(onPick).toHaveBeenCalledWith({ driverKind: 'opencode', modelId: 'other-model' })
  })

  it.each([
    ['model', 'rejected'],
    ['model', 'failed'],
    ['provider', 'rejected'],
    ['provider', 'failed'],
  ] as const)('rolls back an optimistic %s pick when dispatch is %s', async (pick, failure) => {
    const { onPick } = setup('project', true, pick === 'provider' ? 'empty' : 'history')
    const implementation = rpcMocks.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    let fail!: (reason: Error) => void
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'command.dispatch'
        ? new Promise((resolve, reject) => {
            finish = resolve
            fail = reject
          })
        : implementation(method, params),
    )
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    if (pick === 'provider')
      await user.click(
        within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Claude'),
      )
    await user.click(
      within(screen.getByRole('listbox', { name: 'Models' })).getByText(
        pick === 'model' ? 'Other model' : 'Opus',
      ),
    )
    expect(
      screen.getByRole('button', {
        name: pick === 'model' ? /Model: OpenCode · Other model/ : /Model: Claude · Opus/,
      }),
    ).toBeVisible()
    expect(onPick).not.toHaveBeenCalled()
    await act(async () => {
      if (failure === 'failed') fail(new Error('Pick failed'))
      else finish({ accepted: false, reason: 'Pick rejected' })
    })
    expect(screen.getByRole('button', { name: /Model: OpenCode · Current model/ })).toBeVisible()
    expect(onPick).not.toHaveBeenCalled()
  })
  it('rolls back an overlapping failed pick to the last accepted model', async () => {
    const { onPick } = setup('project')
    const implementation = rpcMocks.invoke.getMockImplementation()!
    const pending: ((result: unknown) => void)[] = []
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'command.dispatch'
        ? new Promise((resolve) => pending.push(resolve))
        : implementation(method, params),
    )
    const user = userEvent.setup()
    await screen.findByText('Earlier reply')
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('listbox', { name: 'Models' })).getByText('Other model'),
    )
    await user.click(screen.getByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('listbox', { name: 'Models' })).getByText('Current model'),
    )
    await act(async () => pending[0]!({ accepted: true }))
    expect(screen.getByRole('button', { name: /Model: OpenCode · Current model/ })).toBeVisible()
    await act(async () => pending[1]!({ accepted: false, reason: 'Pick rejected' }))
    expect(screen.getByRole('button', { name: /Model: OpenCode · Other model/ })).toBeVisible()
    expect(onPick).toHaveBeenCalledExactlyOnceWith({
      driverKind: 'opencode',
      modelId: 'other-model',
    })
  })

  it('restores confirmed defaults when an overlapping model pick and provider switch are rejected', async () => {
    const { onPick } = setup('helm')
    const implementation = rpcMocks.invoke.getMockImplementation()!
    const pending: ((result: unknown) => void)[] = []
    rpcMocks.invoke.mockImplementation((method: string, params?: unknown) =>
      method === 'command.dispatch'
        ? new Promise((resolve) => pending.push(resolve))
        : implementation(method, params),
    )
    const user = userEvent.setup()
    await screen.findByText('Earlier reply')
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('listbox', { name: 'Models' })).getByText('Other model'),
    )
    await user.click(screen.getByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Claude'),
    )
    await user.click(within(screen.getByRole('listbox', { name: 'Models' })).getByText('Opus'))
    await act(async () => pending[0]!({ accepted: false, reason: 'Model rejected' }))
    expect(screen.getByRole('button', { name: /Model: OpenCode · Other model/ })).toBeVisible()
    await act(async () => pending[1]!({ accepted: false, reason: 'Switch rejected' }))
    expect(screen.getByRole('button', { name: /Model: OpenCode · Current model/ })).toBeVisible()
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it.each([
    { pick: 'model', accepted: false, effort: 'medium' },
    { pick: 'initial', accepted: false, effort: 'medium' },
    { pick: 'switch', accepted: true, effort: 'medium' },
    { pick: 'switch', accepted: true, effort: 'high' },
  ] as const)(
    'preserves a later $effort effort update after $pick (accepted: $accepted)',
    async ({ pick, accepted, effort }) => {
      const { onPick } = setup(
        pick === 'model' ? 'project' : 'helm',
        true,
        pick === 'initial' ? 'empty' : 'history',
      )
      const implementation = rpcMocks.invoke.getMockImplementation()!
      let finish!: (value: unknown) => void
      rpcMocks.invoke.mockImplementation((method: string, params?: unknown) => {
        if (method === 'providers.efforts')
          return Promise.resolve({
            efforts: [
              { id: 'high', label: 'High' },
              { id: 'medium', label: 'Medium' },
            ],
          })
        const command = (params as { command?: { modelId?: unknown } } | undefined)?.command
        if (method === 'command.dispatch' && command?.modelId !== undefined)
          return new Promise((resolve) => {
            finish = resolve
          })
        return implementation(method, params)
      })
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
      if (pick !== 'model')
        await user.click(
          within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Claude'),
        )
      await user.click(
        within(screen.getByRole('listbox', { name: 'Models' })).getByText(
          pick === 'model' ? 'Other model' : 'Opus',
        ),
      )
      await user.click(await screen.findByRole('button', { name: /Effort:/ }))
      await user.click(
        within(screen.getByRole('listbox', { name: 'Effort' })).getByRole('option', {
          name: effort === 'high' ? 'High' : 'Medium',
        }),
      )
      await act(async () => finish({ accepted, reason: 'Pick rejected' }))
      expect(
        screen.getByRole('button', { name: effort === 'high' ? 'Effort: High' : 'Effort: Medium' }),
      ).toBeVisible()
      if (accepted) {
        expect(screen.getByRole('button', { name: /Model: Claude · Opus/ })).toBeVisible()
        expect(onPick.mock.lastCall).toEqual([{ driverKind: 'claude', modelId: 'opus' }])
      } else {
        expect(
          screen.getByRole('button', { name: /Model: OpenCode · Current model/ }),
        ).toBeVisible()
        expect(onPick).toHaveBeenCalledExactlyOnceWith({ effort })
      }
    },
  )

  it.each(['aria', 'lead'] as const)(
    'lists every ready provider mid-chat for %s and sends an explicit switch',
    async (kind) => {
      const { emit } = setup(kind === 'aria' ? 'helm' : 'project', true, 'history', kind === 'lead')
      const user = userEvent.setup()
      await screen.findByText('Earlier reply')
      await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
      const providers = screen.getByRole('presentation', { name: 'Providers' })
      await waitFor(() => expect(within(providers).getByText('OpenCode')).toBeVisible())
      await user.click(within(providers).getByText('Claude'))
      await user.click(within(screen.getByRole('listbox', { name: 'Models' })).getByText('Opus'))
      expect(rpcMocks.invoke).toHaveBeenCalledWith('command.dispatch', {
        command: {
          type: 'session.provider.switch',
          sessionId: 'aria',
          driverKind: 'claude',
          modelId: 'opus',
          effort: null,
        },
      })
      expect(await screen.findByRole('button', { name: /Model: Claude · Opus/ })).toBeVisible()
      emit({
        seq: 5,
        at: 2,
        sessionId: 'aria',
        type: 'session.provider.switched',
        driverKind: 'claude',
        modelId: 'opus',
        effort: null,
        afterTurnId: 'first',
        afterMessageId: 'reply',
      })
      expect(await screen.findByRole('separator')).toHaveTextContent('Switched to Claude · Opus')
    },
  )

  it('keeps an ordinary session locked to its provider after its first turn', async () => {
    setup('project')
    const user = userEvent.setup()
    await screen.findByText('Earlier reply')
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    expect(screen.queryByRole('presentation', { name: 'Providers' })).toBeNull()
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox', { name: 'Models' })).getByText('Current model'),
      ).toBeVisible(),
    )
    expect(screen.queryByText('Opus')).toBeNull()
    await user.click(
      within(screen.getByRole('listbox', { name: 'Models' })).getByText('Current model'),
    )
    expect(rpcMocks.invoke).toHaveBeenCalledWith('command.dispatch', {
      command: {
        type: 'session.update',
        sessionId: 'aria',
        driverKind: 'opencode',
        modelId: 'current-model',
      },
    })
  })

  it('keeps the selected model when the engine rejects a switch', async () => {
    setup('helm', false)
    const user = userEvent.setup()
    await screen.findByText('Earlier reply')
    await user.click(await screen.findByRole('button', { name: /Model: OpenCode/ }))
    await user.click(
      within(screen.getByRole('presentation', { name: 'Providers' })).getByText('Claude'),
    )
    await user.click(within(screen.getByRole('listbox', { name: 'Models' })).getByText('Opus'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Model: OpenCode · Current model/ })).toBeVisible(),
    )
    expect(await screen.findByText('Switch refused')).toBeVisible()
    expect(screen.queryByRole('separator')).toBeNull()
  })
})
