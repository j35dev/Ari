import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSession } from './RemoteSession'
import { machineFixture, snapshotFixture, catalogFixture } from './fixtures.test-support'
import { readRemoteDraft } from './remote-drafts'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: mocks.subscribe } }))
vi.mock('../transcript/MarkdownBlock', () => ({ MarkdownBlock: ({ text }: { text: string }) => <p>{text}</p> }))
vi.mock('./RemoteTerminal', () => ({ RemoteTerminal: () => <p>Granted host terminal</p> }))
let frames: (raw: unknown) => void

describe('RemoteSession', () => {
  beforeEach(() => {
    localStorage.clear(); mocks.invoke.mockReset(); mocks.subscribe.mockReset(); mocks.dispose.mockReset()
    mocks.subscribe.mockImplementation((_name, _params, listener) => { frames = listener; return mocks.dispose })
    mocks.invoke.mockImplementation(async (method, params) => {
      if (method === 'machines.command') return { ok: true, result: { accepted: true } }
      if (method === 'machines.query') {
        if (params.query.op === 'session.get') return snapshotFixture()
        if (params.query.op === 'models.list') return catalogFixture
        if (params.query.op === 'files.list') return { path: '', entries: [{ name: 'host.ts', path: 'host.ts', kind: 'file', size: 12 }], nextCursor: null, error: null }
        if (params.query.op === 'files.read') return { path: 'host.ts', kind: 'text', size: 12, content: 'host content', error: null }
        if (params.query.op === 'changes.files') return { files: [{ path: 'host.ts' }], base: 'workspace-head', error: null }
        if (params.query.op === 'changes.diff') return { file: { path: 'host.ts', hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', content: 'changed on host' }] }] }, error: null }
      }
      throw new Error(`Unexpected RPC ${method}`)
    })
  })
  it('scopes transcript, prompt, queue, steer, stop and exact provider approvals/questions to the host', async () => {
    const snapshot = snapshotFixture()
    snapshot.pendingApprovals = [{ approvalId: 'approval', toolName: 'shell', summaryJson: '{"cmd":"test"}', options: [{ optionId: 'prefix-specific', name: 'Allow this prefix', kind: 'allow_always' }, { optionId: 'session-specific', name: 'Allow this session', kind: 'allow_always' }] }]
    snapshot.pendingInputs = [{ inputId: 'input', prompt: 'Which branch?', choicesJson: '["main","feature"]' }]
    mocks.invoke.mockImplementation(async (method, params) => method === 'machines.query' && params.query.op === 'session.get' ? snapshot : { ok: true, result: { accepted: true } })
    const user = userEvent.setup()
    render(<RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />)
    await screen.findByText('Hello from the host')
    await user.click(screen.getByRole('button', { name: 'Allow this session' }))
    await user.click(screen.getByRole('button', { name: /main/ }))
    for (const name of ['Send', 'Queue', 'Steer']) {
      await user.type(screen.getByRole('textbox', { name: 'Prompt on Studio computer' }), `Host ${name}`)
      await user.click(screen.getByRole('button', { name, exact: true }))
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt on Studio computer' })).toHaveValue(''))
    }
    await user.click(screen.getByRole('button', { name: 'Stop', exact: true }))
    const commands = mocks.invoke.mock.calls.filter(([name]) => name === 'machines.command').map(([, params]) => params)
    expect(commands.every((params) => params.machineId === 'host-a' && params.command.sessionId === 'same-session')).toBe(true)
    expect(commands.map((params) => params.command.op)).toEqual(['approval.respond', 'input.respond', 'session.prompt', 'session.queue', 'session.steer', 'session.interrupt'])
    expect(commands[0].command.optionId).toBe('session-specific')
    expect(commands[1].command.value).toBe('main')
    expect(mocks.invoke.mock.calls.every(([name]) => name.startsWith('machines.'))).toBe(true)
  })
  it('rejects another host or session stream, resumes from the snapshot, and cleans up on switching', async () => {
    const first = machineFixture()
    const { rerender } = render(<RemoteSession key={first.id} machine={first} sessionId="same-session" onOpenSession={vi.fn()} />)
    await screen.findByText('Hello from the host')
    expect(mocks.subscribe).toHaveBeenCalledWith('machines.events', { machineId: 'host-a', sessionId: 'same-session', fromSeq: 12 }, expect.any(Function))
    const calls = mocks.invoke.mock.calls.length
    act(() => { frames({ machineId: 'host-b', message: { type: 'events.frame', sessionId: 'same-session', events: [] } }); frames({ machineId: 'host-a', message: { type: 'events.frame', sessionId: 'other-session', events: [] } }) })
    expect(mocks.invoke).toHaveBeenCalledTimes(calls)
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox', { name: 'Prompt on Studio computer' }), 'Draft on A')
    rerender(<RemoteSession key="host-b" machine={machineFixture('host-b')} sessionId="same-session" onOpenSession={vi.fn()} />)
    await screen.findByRole('textbox', { name: 'Prompt on Build computer' })
    expect(screen.getByRole('textbox', { name: 'Prompt on Build computer' })).toHaveValue('')
    expect(readRemoteDraft('host-a', 'same-session').text).toBe('Draft on A')
    expect(mocks.dispose).toHaveBeenCalled()
  })
  it('routes file previews and diffs only through machine queries, and never infers a terminal grant', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />)
    await screen.findByText('Hello from the host')
    expect(screen.queryByRole('button', { name: 'Terminal', exact: true })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Files', exact: true }))
    await user.click(await screen.findByRole('button', { name: 'host.ts' }))
    await screen.findByText('host content')
    await user.click(screen.getByRole('button', { name: 'Changes', exact: true }))
    await user.click(await screen.findByRole('button', { name: 'host.ts' }))
    await screen.findByText('+changed on host')
    const queries = mocks.invoke.mock.calls.filter(([name]) => name === 'machines.query').map(([, params]) => params)
    expect(queries.every((params) => params.machineId === 'host-a')).toBe(true)
    expect(queries.some((params) => params.query.op === 'files.read' && params.query.path === 'host.ts')).toBe(true)
    rerender(<RemoteSession machine={{ ...machineFixture(), allowTerminal: true }} sessionId="same-session" onOpenSession={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Terminal', exact: true }))
    expect(screen.getByText('Granted host terminal')).toBeInTheDocument()
    rerender(<RemoteSession machine={{ ...machineFixture(), status: 'revoked' }} sessionId="same-session" onOpenSession={vi.fn()} />)
    expect(screen.queryByText('Granted host terminal')).not.toBeInTheDocument()
  })
  it('retains an offline draft and blocks mutations without automatic retry', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<RemoteSession machine={machineFixture()} sessionId="same-session" onOpenSession={vi.fn()} />)
    await screen.findByText('Hello from the host')
    await user.type(screen.getByRole('textbox', { name: 'Prompt on Studio computer' }), 'Keep this')
    mocks.invoke.mockRejectedValueOnce(new Error('Lost reply'))
    await user.click(screen.getByRole('button', { name: 'Send', exact: true }))
    await screen.findByRole('region', { name: 'Unconfirmed remote action' })
    rerender(<RemoteSession machine={{ ...machineFixture(), status: 'offline' }} sessionId="same-session" onOpenSession={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Check receipt' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Prompt on Studio computer' })).toHaveValue('Keep this')
    expect(mocks.invoke.mock.calls.filter(([name]) => name === 'machines.command')).toHaveLength(1)
  })
})
