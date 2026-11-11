import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSession } from './RemoteSession'
import { machineFixture, snapshotFixture, catalogFixture } from './fixtures.test-support'
import { readRemoteDraft } from './remote-drafts'
import { readReceipt } from './remote-client'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: mocks.subscribe } }))
vi.mock('../transcript/MarkdownBlock', () => ({
  MarkdownBlock: ({ text }: { text: string }) => <p>{text}</p>,
}))
vi.mock('./RemoteTerminal', () => ({ RemoteTerminal: () => <p>Granted host terminal</p> }))
let frames: (raw: unknown) => void
const reply = (result: unknown) => ({ ok: true, result })

describe('RemoteSession', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.invoke.mockReset()
    mocks.subscribe.mockReset()
    mocks.dispose.mockReset()
    mocks.subscribe.mockImplementation((_name, _params, listener) => {
      frames = listener
      return mocks.dispose
    })
    mocks.invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.command') return { ok: true, result: { accepted: true } }
      if (method === 'machines.query') {
        if (params.query.op === 'session.get') return reply(snapshotFixture())
        if (params.query.op === 'models.list') return reply(catalogFixture)
        if (params.query.op === 'files.list')
          return reply({
            path: '',
            entries: [{ name: 'host.ts', path: 'host.ts', kind: 'file', size: 12 }],
            nextCursor: null,
            error: null,
          })
        if (params.query.op === 'files.read')
          return reply({
            path: 'host.ts',
            kind: 'text',
            size: 12,
            content: 'host content',
            error: null,
          })
        if (params.query.op === 'changes.files')
          return reply({ files: [{ path: 'host.ts' }], base: 'workspace-head', error: null })
        if (params.query.op === 'changes.diff')
          return reply({
            file: {
              path: 'host.ts',
              hunks: [
                { header: '@@ -1 +1 @@', lines: [{ type: 'add', content: 'changed on host' }] },
              ],
            },
            error: null,
          })
      }
      throw new Error(`Unexpected RPC ${method}`)
    })
  })
  it('scopes transcript, prompt, queue, steer, stop and exact provider approvals/questions to the host', async () => {
    const snapshot = snapshotFixture()
    snapshot.pendingApprovals = [
      {
        approvalId: 'approval',
        toolName: 'shell',
        summaryJson: '{"cmd":"test"}',
        options: [
          { optionId: 'prefix-specific', name: 'Allow this prefix', kind: 'allow_always' },
          { optionId: 'session-specific', name: 'Allow this session', kind: 'allow_always' },
        ],
      },
    ]
    snapshot.pendingInputs = [
      { inputId: 'input', prompt: 'Which branch?', choicesJson: '["main","feature"]' },
    ]
    mocks.invoke.mockImplementation(async (method, params) =>
      method === 'machines.query' && params.query.op === 'session.get'
        ? reply(snapshot)
        : { ok: true, result: { accepted: true } },
    )
    const user = userEvent.setup()
    render(
      <RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />,
    )
    await screen.findByText('Hello from the host')
    await user.click(screen.getByRole('button', { name: 'Allow this session' }))
    await user.click(screen.getByRole('button', { name: /main/ }))
    for (const name of ['Send', 'Queue', 'Steer']) {
      await user.type(
        screen.getByRole('textbox', { name: 'Prompt on Studio computer' }),
        `Host ${name}`,
      )
      await user.click(screen.getByRole('button', { name, exact: true }))
      await waitFor(() =>
        expect(screen.getByRole('textbox', { name: 'Prompt on Studio computer' })).toHaveValue(''),
      )
    }
    await user.click(screen.getByRole('button', { name: 'Stop', exact: true }))
    const commands = mocks.invoke.mock.calls
      .filter(([name]) => name === 'machines.command')
      .map(([, params]) => params)
    expect(
      commands.every(
        (params) => params.machineId === 'host-a' && params.command.sessionId === 'same-session',
      ),
    ).toBe(true)
    expect(commands.map((params) => params.command.op)).toEqual([
      'approval.respond',
      'input.respond',
      'session.prompt',
      'session.queue',
      'session.steer',
      'session.interrupt',
    ])
    expect(commands[0].command.optionId).toBe('session-specific')
    expect(commands[1].command.value).toBe('main')
    expect(mocks.invoke.mock.calls.every(([name]) => name.startsWith('machines.'))).toBe(true)
  })
  it('rejects another host or session stream, resumes from the snapshot, and cleans up on switching', async () => {
    const first = machineFixture()
    const { rerender } = render(
      <RemoteSession
        key={first.id}
        machine={first}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    await screen.findByText('Hello from the host')
    expect(mocks.subscribe).toHaveBeenCalledWith(
      'machines.events',
      { machineId: 'host-a', sessionId: 'same-session', fromSeq: 12 },
      expect.any(Function),
    )
    const calls = mocks.invoke.mock.calls.length
    act(() => {
      frames({
        machineId: 'host-b',
        message: { type: 'events.frame', sessionId: 'same-session', events: [] },
      })
      frames({
        machineId: 'host-a',
        message: { type: 'events.frame', sessionId: 'other-session', events: [] },
      })
    })
    expect(mocks.invoke).toHaveBeenCalledTimes(calls)
    const user = userEvent.setup()
    await user.type(
      screen.getByRole('textbox', { name: 'Prompt on Studio computer' }),
      'Draft on A',
    )
    rerender(
      <RemoteSession
        key="host-b"
        machine={machineFixture('host-b')}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    await screen.findByRole('textbox', { name: 'Prompt on Build computer' })
    expect(screen.getByRole('textbox', { name: 'Prompt on Build computer' })).toHaveValue('')
    expect(readRemoteDraft('host-a', 'same-session').text).toBe('Draft on A')
    expect(mocks.dispose).toHaveBeenCalled()
  })
  it('routes file previews and diffs only through machine queries, and never infers a terminal grant', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />,
    )
    await screen.findByText('Hello from the host')
    expect(screen.queryByRole('button', { name: 'Terminal', exact: true })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Files', exact: true }))
    await user.click(await screen.findByRole('button', { name: 'host.ts' }))
    await screen.findByText('host content')
    await user.click(screen.getByRole('button', { name: 'Changes', exact: true }))
    await user.click(await screen.findByRole('button', { name: 'host.ts' }))
    await screen.findByText('+changed on host')
    const queries = mocks.invoke.mock.calls
      .filter(([name]) => name === 'machines.query')
      .map(([, params]) => params)
    expect(queries.every((params) => params.machineId === 'host-a')).toBe(true)
    expect(
      queries.some((params) => params.query.op === 'files.read' && params.query.path === 'host.ts'),
    ).toBe(true)
    rerender(
      <RemoteSession
        machine={{ ...machineFixture(), allowTerminal: true }}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Terminal', exact: true }))
    expect(screen.getByText('Granted host terminal')).toBeInTheDocument()
    rerender(
      <RemoteSession
        machine={{ ...machineFixture(), status: 'revoked' }}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    expect(screen.queryByText('Granted host terminal')).not.toBeInTheDocument()
  })
  it('retains an offline draft and blocks mutations without automatic retry', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />,
    )
    await screen.findByText('Hello from the host')
    await user.type(screen.getByRole('textbox', { name: 'Prompt on Studio computer' }), 'Keep this')
    mocks.invoke.mockRejectedValueOnce(new Error('Lost reply'))
    await user.click(screen.getByRole('button', { name: 'Send', exact: true }))
    await screen.findByRole('region', { name: 'Unconfirmed remote action' })
    rerender(
      <RemoteSession
        machine={{ ...machineFixture(), status: 'offline' }}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check receipt' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Prompt on Studio computer' })).toHaveValue(
      'Keep this',
    )
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'machines.command')).toHaveLength(1)
  })
  it('follows output at the bottom, preserves manual scrollback, and restores following explicitly', async () => {
    const user = userEvent.setup()
    render(
      <RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />,
    )
    await screen.findByText('Hello from the host')
    const transcript = screen.getByLabelText('Remote transcript')
    Object.defineProperties(transcript, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    })
    transcript.scrollTop = 200
    fireEvent.scroll(transcript)
    mocks.invoke.mockResolvedValueOnce(
      reply(snapshotFixture('same-session', 'New streamed output')),
    )
    act(() =>
      frames({
        machineId: 'host-a',
        message: {
          type: 'events.frame',
          sessionId: 'same-session',
          events: [{ seq: 13, event: {} }],
        },
      }),
    )
    await screen.findByText('New streamed output')
    expect(transcript.scrollTop).toBe(200)
    await user.click(screen.getByRole('button', { name: 'Latest messages' }))
    expect(transcript.scrollTop).toBe(1000)
  })
  it('ignores a late old-host snapshot after switching to the same session ID on another host', async () => {
    let complete!: (result: unknown) => void
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const { rerender } = render(
      <RemoteSession
        key="host-a"
        machine={machineFixture()}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    rerender(
      <RemoteSession
        key="host-b"
        machine={machineFixture('host-b')}
        sessionId="same-session"
        onOpenSession={vi.fn()}
      />,
    )
    await screen.findByText('Hello from the host')
    await act(async () =>
      complete(reply(snapshotFixture('same-session', 'Late data from old host'))),
    )
    expect(screen.queryByText('Late data from old host')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Prompt on Build computer' })).toBeInTheDocument()
  })
  it('opens a fork using the real wire sessionId result on the same host', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (method, params) =>
      params.command?.op === 'session.fork'
        ? reply({ sessionId: 'forked-on-host' })
        : original(method, params),
    )
    render(
      <RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={open} />,
    )
    await screen.findByText('Hello from the host')
    await user.click(screen.getByRole('button', { name: 'Details', exact: true }))
    await user.type(screen.getByRole('textbox', { name: 'Fork name' }), 'Host fork')
    await user.click(screen.getByRole('button', { name: 'Fork on host' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('forked-on-host'))
    expect(
      mocks.invoke.mock.calls.find(([, params]) => params.command?.op === 'session.fork')?.[1],
    ).toMatchObject({
      machineId: 'host-a',
      command: { sessionId: 'same-session', title: 'Host fork' },
    })
  })
  it('stores uncertain child interruption under the child scope and links to its reconciliation', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const parent = snapshotFixture()
    parent.tasks = [
      {
        sessionId: 'child-session',
        parentSessionId: 'same-session',
        title: 'Build agent',
        role: 'implementation',
        driverKind: 'codex',
        modelId: 'gpt-6.1-sol',
        workState: 'working',
        blockedOn: null,
        queuedMessages: 0,
        latestTurn: null,
        report: null,
        reportTruncated: false,
        delivered: null,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
        workspaceKind: 'project',
        branch: null,
      },
    ]
    const original = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (method, params) => {
      if (params.command?.op === 'session.interrupt')
        return {
          ok: false,
          error: { code: 'internal_error', message: 'Unknown child stop outcome' },
        }
      if (params.query?.op === 'session.get')
        return reply(
          params.query.sessionId === 'same-session' ? parent : snapshotFixture('child-session'),
        )
      if (params.query?.op === 'command.status')
        return reply({ ok: true, result: { accepted: true } })
      return original(method, params)
    })
    const { rerender } = render(
      <RemoteSession
        key="parent"
        machine={machineFixture()}
        sessionId="same-session"
        onOpenSession={open}
      />,
    )
    await screen.findByText('Build agent')
    await user.click(screen.getByRole('button', { name: 'Stop agent' }))
    await screen.findByRole('button', { name: 'Open affected agent' })
    expect(readReceipt('host-a', 'same-session')).toBeNull()
    const saved = readReceipt('host-a', 'child-session')!
    expect(saved.command).toMatchObject({ op: 'session.interrupt', sessionId: 'child-session' })
    await user.click(screen.getByRole('button', { name: 'Open affected agent' }))
    expect(open).toHaveBeenCalledWith('child-session')
    rerender(
      <RemoteSession
        key="child"
        machine={machineFixture()}
        sessionId="child-session"
        onOpenSession={open}
      />,
    )
    await screen.findByText('Hello from the host')
    await user.click(screen.getByRole('button', { name: 'Check receipt' }))
    await waitFor(() => expect(readReceipt('host-a', 'child-session')).toBeNull())
    expect(
      mocks.invoke.mock.calls.filter(([method]) => method === 'machines.command'),
    ).toHaveLength(1)
  })
})
