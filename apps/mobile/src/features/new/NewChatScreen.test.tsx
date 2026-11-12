// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { RemoteError } from '../../lib/gateway-client'
import { NewChatScreen } from './NewChatScreen'

const app = vi.hoisted(() => ({
  origin: 'https://computer.example',
  connection: 'connected',
  projects: [
    { id: 'ari', name: 'Ari', sessionCount: 1 },
    { id: 'site', name: 'Website', sessionCount: 0 },
  ],
  catalog: null as RemoteModelCatalog | null,
  refresh: vi.fn(async () => {}),
  session: {
    deviceId: 'phone-1',
    supports: vi.fn((op: string) => op !== 'models.efforts'),
    send: vi.fn<(command: { op: string }, key?: string) => Promise<unknown>>(),
    query: vi.fn(),
  },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))

const created = { ok: true, result: { sessionId: 'new-1' } }
const handlers = { onBack: vi.fn(), onOpen: vi.fn() }
beforeEach(() => {
  sessionStorage.clear()
  app.projects = [
    { id: 'ari', name: 'Ari', sessionCount: 1 },
    { id: 'site', name: 'Website', sessionCount: 0 },
  ]
  app.catalog = {
    defaults: {
      driverKind: 'codex',
      modelId: null,
      configuredDriverKind: 'codex',
      permissionMode: 'ask',
    },
    providers: [
      {
        driverKind: 'codex',
        available: true,
        models: [],
        efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', current: true },
        ],
        modes: [],
      },
    ],
  }
  app.refresh.mockResolvedValue(undefined)
  app.session.query.mockReset().mockResolvedValue(created)
  app.session.send.mockImplementation(async (command) =>
    command.op === 'session.create' ? created : { ok: true },
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const write = (text: string): void => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Describe a task' }), {
    target: { value: text },
  })
}
const sent = (): unknown[] => app.session.send.mock.calls.map(([command]) => command)

describe('starting a new chat', () => {
  it('creates the session, sends the first message, and opens it', async () => {
    render(<NewChatScreen {...handlers} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true)
    write('Fix the flaky test')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(handlers.onOpen).toHaveBeenCalledWith('new-1'))
    expect(sent()).toEqual([
      { op: 'session.create', projectId: 'ari' },
      { op: 'session.prompt', sessionId: 'new-1', text: 'Fix the flaky test' },
    ])
    expect(sessionStorage.length).toBe(0)
  })

  it('starts it in the project, effort and permission mode the user chose', async () => {
    render(<NewChatScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Project: Ari' }))
    fireEvent.click(screen.getByRole('button', { name: /^Website/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Ask' }))
    fireEvent.click(screen.getByRole('button', { name: /^Full auto/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Effort: High' }))
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }))
    write('Ship it')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(handlers.onOpen).toHaveBeenCalled())
    expect(sent()[0]).toEqual({
      op: 'session.create',
      projectId: 'site',
      permissionMode: 'full',
      effort: 'low',
    })
  })

  it('opens in the project it was started from', () => {
    render(<NewChatScreen {...handlers} projectId="site" />)
    expect(screen.getByRole('button', { name: 'Project: Website' })).toBeTruthy()
  })

  it('restores a creation whose answer was lost and checks its receipt without resending', async () => {
    app.session.send
      .mockRejectedValueOnce(new RemoteError('unreachable', 'lost acknowledgement'))
      .mockImplementation(async (command) =>
        command.op === 'session.create' ? created : { ok: true },
      )
    const { unmount } = render(<NewChatScreen {...handlers} />)
    write('Build this task')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toContain('lost acknowledgement')
    const first = app.session.send.mock.calls[0]
    unmount()
    render(<NewChatScreen {...handlers} />)
    expect(screen.getByRole('alert').textContent).toContain('was not confirmed')
    expect(app.session.send).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(handlers.onOpen).toHaveBeenCalledWith('new-1'))
    expect(app.session.query).toHaveBeenCalledExactlyOnceWith('command.status', { idempotencyKey: first?.[1] })
    expect(sent()[1]).toEqual({
      op: 'session.prompt',
      sessionId: 'new-1',
      text: 'Build this task',
    })
  })

  it.each([null, { ok: true, result: {} }, new RemoteError('not_found', 'History absent')])(
    'keeps an unconfirmed creation and never resubmits missing or corrupt history: %j', async (outcome) => {
      app.session.send.mockRejectedValueOnce(new RemoteError('unreachable', 'lost acknowledgement'))
      if (outcome instanceof Error) app.session.query.mockRejectedValue(outcome)
      else app.session.query.mockResolvedValue(outcome)
      render(<NewChatScreen {...handlers} />)
      write('Run this once')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await screen.findByRole('alert')
      const stored = sessionStorage.getItem('ari.creation:https://computer.example:phone-1')
      expect(stored).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(app.session.query).toHaveBeenCalledOnce())
      await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' }).disabled).toBe(false))
      expect(app.session.send).toHaveBeenCalledOnce()
      expect(sessionStorage.getItem('ari.creation:https://computer.example:phone-1')).toBe(stored)
      expect(handlers.onOpen).not.toHaveBeenCalled()
    },
  )

  it('retains a confirmed creation after leaving without sending a first prompt or navigating', async () => {
    let resolve!: (outcome: unknown) => void
    app.session.send.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const view = render(<NewChatScreen {...handlers} />)
    write('Keep on this computer')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    view.unmount()
    await act(async () => resolve(created))
    expect(app.session.send).toHaveBeenCalledOnce()
    expect(handlers.onOpen).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('ari.creation:https://computer.example:phone-1')).not.toBeNull()
  })

  it('restores an unsent new-chat draft only for the same origin and device', () => {
    const view = render(<NewChatScreen {...handlers} />)
    write('Studio draft')
    view.unmount()
    app.session.deviceId = 'phone-2'
    const second = render(<NewChatScreen {...handlers} />)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Describe a task' }).value).toBe('')
    second.unmount()
    app.session.deviceId = 'phone-1'
    render(<NewChatScreen {...handlers} />)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Describe a task' }).value).toBe('Studio draft')
    expect(app.session.send).not.toHaveBeenCalled()
  })

  it('opens the session with the message kept for a retry when sending it is uncertain', async () => {
    app.session.send.mockImplementation(async (command) => {
      if (command.op === 'session.create') return created
      throw new RemoteError('unreachable', 'lost acknowledgement')
    })
    render(<NewChatScreen {...handlers} />)
    write('Fix the flaky test')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(handlers.onOpen).toHaveBeenCalledWith('new-1'))
    expect(
      sessionStorage.getItem('ari.pending:https://computer.example:phone-1:new-1'),
    ).toContain('Fix the flaky test')
  })

  it('opens the session with the message as a draft when the computer refuses it', async () => {
    app.session.send.mockImplementation(async (command) => {
      if (command.op === 'session.create') return created
      throw new RemoteError('unsupported_capability', 'this provider is signed out')
    })
    render(<NewChatScreen {...handlers} />)
    write('Fix the flaky test')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(handlers.onOpen).toHaveBeenCalledWith('new-1'))
    expect(sessionStorage.getItem('ari.draft:https://computer.example:phone-1:new-1')).toBe(
      'Fix the flaky test',
    )
    expect(sessionStorage.getItem('ari.pending:https://computer.example:phone-1:new-1')).toBeNull()
  })

  it('opens a confirmed session even if refreshing the list fails', async () => {
    app.refresh.mockRejectedValue(new Error('offline list'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<NewChatScreen {...handlers} />)
    write('Go')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(handlers.onOpen).toHaveBeenCalledWith('new-1'))
    warning.mockRestore()
  })

  it('says what to do when no project is shared with this phone', () => {
    app.projects = []
    render(<NewChatScreen {...handlers} />)
    expect(screen.getByText('Share a project first')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('goes back without creating anything', () => {
    render(<NewChatScreen {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(handlers.onBack).toHaveBeenCalledOnce()
    expect(app.session.send).not.toHaveBeenCalled()
  })
})
