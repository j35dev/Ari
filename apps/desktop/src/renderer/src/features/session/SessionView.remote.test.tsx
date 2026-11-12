import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@ari/ui/toast'
import type { JournalEvent } from '@ari/contracts/events'
import { SessionView, type SessionDefaults } from './SessionView'
import { desktopMachineFixture, desktopSnapshotFixture, catalogFixture } from '../machines/fixtures.test-support'
import { refreshMachineInventory } from './session-machine-access'
import { readReceipt } from '../machines/remote-client'
import { sessionViewKey, SessionClientProvider } from './session-client'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: bridge }))
// Speech is a separate input capability owned by the composer/shell seam.
vi.mock('../composer/SpeechButton', () => ({ SpeechButton: () => null }))
vi.mock('../transcript/MarkdownBlock', () => ({ MarkdownBlock: ({ text }: { text: string }) => <p>{text}</p> }))
Element.prototype.scrollTo = () => {}
Element.prototype.getBoundingClientRect = () => ({ height: 64 }) as DOMRect
const scope = { kind: 'remote' as const, machineId: 'host-a', sessionId: 'sess_remote' }
const defaults: SessionDefaults = { driverKind: 'codex', modelId: 'gpt-6.1-sol', effort: 'high', permissionMode: 'ask' }
let listener: (frame: unknown) => void
let machines: ReturnType<typeof desktopMachineFixture>[]
let failCommands = false
const commands = () => bridge.invoke.mock.calls.filter(([method]) => method === 'machines.command')
const emit = (frame: unknown) => act(() => listener({ machineId: scope.machineId, message: { type: 'events.desktop.frame', sessionId: scope.sessionId, frame } }))
const journal = (seq: number, value: Record<string, unknown>) => ({ seq, at: seq, sessionId: scope.sessionId, ...value }) as JournalEvent
const message = (seq: number, text: string) => journal(seq, { type: 'user.message.added', message: {
  id: `user_${seq}`, sessionId: scope.sessionId, turnId: null, role: 'user', createdAt: seq, parts: [{ type: 'text', text }],
} })

beforeEach(async () => {
  localStorage.clear()
  machines = [desktopMachineFixture()]
  failCommands = false
  bridge.invoke.mockReset()
  bridge.subscribe.mockReset()
  bridge.subscribe.mockImplementation((name, _params, callback) => {
    if (name === 'machines.events') listener = callback
    return () => {}
  })
  bridge.invoke.mockImplementation(async (method, params) => {
    if (method === 'machines.list') return machines
    if (method === 'settings.get') return { notifications: { settleSound: false }, appearance: {} }
    if (method === 'machines.command') {
      if (failCommands) throw new Error('response lost after host execution')
      return { ok: true, result: { accepted: true } }
    }
    if (method === 'machines.query') {
      const query = params.query
      const results: Record<string, unknown> = {
        'session.desktop.get': desktopSnapshotFixture(), 'models.list': catalogFixture,
        'models.efforts': { efforts: [{ id: 'high', label: 'High' }] },
        'files.index': { paths: ['host.ts'], nextCursor: null, truncated: false },
        'plan.get': { items: null },
      }
      if (query.op === 'command.status') return { ok: false, error: { code: 'not_found', message: 'original result not retained' } }
      if (query.op in results) return { ok: true, result: results[query.op] }
    }
    throw new Error(`Unexpected local call: ${method}`)
  })
  await refreshMachineInventory()
})
afterEach(cleanup)
const view = () => <ToastProvider><SessionView scope={scope} sessionId={scope.sessionId} defaults={defaults} onDefaultsChange={() => {}} /></ToastProvider>
async function mountHistory(events: JournalEvent[] = []) {
  render(view())
  await waitFor(() => expect(bridge.subscribe.mock.calls.some(([name]) => name === 'machines.events')).toBe(true))
  emit({ kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: events.at(-1)?.seq ?? -1 })
  if (events.length) emit({ kind: 'chunk', events })
  emit({ kind: 'terminal', replayOutcome: 'complete', seq: events.at(-1)?.seq ?? -1, liveTurnId: null, reason: null })
  await screen.findByLabelText('Message')
}

describe('normal remote SessionView', () => {
  it('uses host journal/composer and exact host approval options without local session or provider RPC', async () => {
    await mountHistory([message(0, 'Host history')])
    expect(await screen.findByText('Host history')).toBeVisible()
    emit({ kind: 'live', event: journal(1, { type: 'turn.started', turnId: 'live-turn' }) })
    emit({ kind: 'live', event: journal(2, { type: 'approval.requested', approvalId: 'approval', toolName: 'shell', summaryJson: '{}',
      options: [{ optionId: 'host-prefix-option', name: 'Allow host prefix', kind: 'allow_always' }] }) })
    fireEvent.click(await screen.findByRole('button', { name: /Allow host prefix/ }))
    await waitFor(() => expect(commands()).toHaveLength(1))
    expect(commands()[0]?.[1]).toMatchObject({ machineId: 'host-a', command: { op: 'approval.respond', sessionId: 'sess_remote', optionId: 'host-prefix-option' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Queue on host' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(commands()).toHaveLength(2))
    expect(commands()[1]?.[1]).toMatchObject({ command: { op: 'session.queue', sessionId: 'sess_remote', text: 'Queue on host' } })
    expect(bridge.invoke.mock.calls.every(([method]) => ['machines.list', 'machines.query', 'machines.command', 'settings.get'].includes(method))).toBe(true)
  })

  it('keeps uncertain submissions read-only and status checks never send the prompt again', async () => {
    await mountHistory([message(0, 'Previous host prompt')])
    failCommands = true
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Send once' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    const check = await screen.findByRole('button', { name: 'Check status' })
    const original = readReceipt(scope.machineId, scope.sessionId)!
    expect(original.command.op).toBe('session.prompt')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    fireEvent.click(check)
    await waitFor(() => expect(bridge.invoke.mock.calls.some(([, params]) => params?.query?.op === 'command.status')).toBe(true))
    expect(readReceipt(scope.machineId, scope.sessionId)).toEqual(original)
    expect(commands()).toHaveLength(1)
  })

  it('retains cached transcript while offline and clears it after explicit revocation', async () => {
    await mountHistory([message(0, 'Authorized cached row')])
    expect(await screen.findByText('Authorized cached row')).toBeVisible()
    machines = [{ ...desktopMachineFixture(), status: 'offline' }]
    await act(() => refreshMachineInventory())
    expect(screen.getByText('Authorized cached row')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    machines = [{ ...desktopMachineFixture(), status: 'revoked' }]
    await act(() => refreshMachineInventory())
    expect(screen.queryByText('Authorized cached row')).toBeNull()
  })

  it('reattaches child views to the inherited host and decodes only recognized navigation keys', async () => {
    render(<ToastProvider><SessionClientProvider scope={scope}>
      <SessionView sessionId="sess_child" defaults={defaults} onDefaultsChange={() => {}} />
    </SessionClientProvider></ToastProvider>)
    await waitFor(() => expect(bridge.subscribe.mock.calls.some(([name, params]) => name === 'machines.events' && params.sessionId === 'sess_child')).toBe(true))
    expect(bridge.subscribe.mock.calls.find(([name]) => name === 'machines.events')?.[1]).toMatchObject({ machineId: 'host-a', sessionId: 'sess_child' })
    cleanup()
    render(<ToastProvider><SessionView sessionId={sessionViewKey(scope)} defaults={defaults} onDefaultsChange={() => {}} /></ToastProvider>)
    await waitFor(() => expect(bridge.subscribe.mock.calls.some(([name, params]) => name === 'machines.events' && params.sessionId === scope.sessionId)).toBe(true))
  })
})
