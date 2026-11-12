import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEvent } from '@ari/contracts/events'
import type { SessionEventFrame } from '@ari/contracts/rpc'
import { desktopMachineFixture, catalogFixture } from '../machines/fixtures.test-support'
import { createSessionClient, SessionClientProvider, useSessionClient, sessionViewKey, parseSessionViewKey } from './session-client'
import { refreshMachineInventory } from './session-machine-access'
import { readReceipt } from '../machines/remote-client'
import { transcriptStore } from './transcript-store'
import { historyJournal } from './history-journal'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: bridge }))
let machines: ReturnType<typeof desktopMachineFixture>[]
let frames: (value: unknown) => void
const stop = vi.fn()
const scope = { kind: 'remote' as const, machineId: 'host-a', sessionId: 'sess_same' }
const commands = () => bridge.invoke.mock.calls.filter(([method]) => method === 'machines.command')
const success = (result: unknown) => ({ ok: true, result })
const event = (seq: number, text = `row ${seq}`): JournalEvent => ({
  type: 'user.message.added', sessionId: scope.sessionId, at: seq, seq,
  message: { id: `message_${seq}`, sessionId: scope.sessionId, turnId: null, role: 'user',
    createdAt: seq, parts: [{ type: 'text', text }] },
})

beforeEach(async () => {
  localStorage.clear()
  machines = [desktopMachineFixture('host-a'), desktopMachineFixture('host-b')]
  bridge.invoke.mockReset()
  bridge.subscribe.mockReset()
  stop.mockReset()
  bridge.subscribe.mockImplementation((name, _params, callback) => {
    if (name === 'machines.events') frames = callback
    return stop
  })
  bridge.invoke.mockImplementation(async (method, params) => {
    if (method === 'machines.list') return machines
    if (method === 'machines.command') return success(params.command.op === 'session.provider.switch'
      ? { accepted: true, switchTiming: { effective: 'ready', afterTurnId: null } } : { accepted: true })
    if (method === 'machines.query' && params.query.op === 'models.list') return success(catalogFixture)
    throw new Error(`Unexpected local operation: ${method}`)
  })
  await refreshMachineInventory()
})
afterEach(cleanup)

describe('normal session host boundary', () => {
  it('keeps local and identical wire IDs on separate hosts in separate stores and rejects unknown keys', () => {
    const keys = [sessionViewKey(scope), sessionViewKey({ ...scope, machineId: 'host-b' }), 'sess_same']
    expect(new Set(keys).size).toBe(3)
    expect(new Set(keys.map(transcriptStore)).size).toBe(3)
    expect(parseSessionViewKey(keys[0]!)).toEqual(scope)
    for (const key of ['unknown', '["host-a"]', '[ "host-a", "sess_same" ]', '[]'])
      expect(parseSessionViewKey(key)).toBeNull()
  })

  it('rejects unsupported methods and mismatched session/project scopes before local dispatch', async () => {
    const client = createSessionClient(scope)
    await expect(client.invoke('session.load', { sessionId: 'sess_other' })).rejects.toThrow('another session')
    await expect(client.invoke('fs.list', { projectId: 'local-project', path: '.' })).rejects.toThrow('client project root')
    await expect(client.invoke('providers.detect')).rejects.toThrow('does not support')
    await expect(client.invoke('command.dispatch', { command: { type: 'session.destroy', sessionId: scope.sessionId } })).rejects.toThrow('unavailable')
    expect(bridge.invoke.mock.calls.map(([method]) => method)).toEqual(['machines.list'])
  })

  it('allows ordinary human queue priority and refuses held/routine/room policy before sending', async () => {
    const client = createSessionClient(scope)
    await client.invoke('command.dispatch', { command: { type: 'message.enqueue', sessionId: scope.sessionId, text: 'ordinary', priority: 'human' } })
    expect(commands()[0]?.[1]).toMatchObject({ machineId: scope.machineId, command: { op: 'session.queue', sessionId: scope.sessionId, text: 'ordinary' } })
    for (const policy of [{ priority: 'routine' }, { priority: 'room' }, { hold: true }])
      await expect(client.invoke('command.dispatch', { command: { type: 'message.enqueue', sessionId: scope.sessionId, text: 'delegated', ...policy } })).rejects.toThrow('policy is unavailable')
    expect(commands()).toHaveLength(1)
  })

  it('routes prompt, dequeue, steer, stop, answers and provider switch to the exact host', async () => {
    const client = createSessionClient(scope)
    const attachment = { id: 'image', name: 'image.png', mimeType: 'image/png', size: 4 }
    for (const command of [
      { type: 'turn.start', text: 'send' }, { type: 'message.dequeue', text: 'queued' },
      { type: 'message.steer', text: 'text steer' }, { type: 'message.steer', text: 'image steer', attachments: [attachment] },
      { type: 'turn.interrupt' }, { type: 'approval.respond', approvalId: 'approval', optionId: 'host-option' },
      { type: 'input.respond', inputId: 'question', value: 'answer' },
      { type: 'session.provider.switch', driverKind: 'codex', modelId: 'gpt-6.1-sol', effort: 'high' },
    ]) await client.invoke('command.dispatch', { command: { ...command, sessionId: scope.sessionId } })
    expect(commands().map(([, params]) => params.command.op)).toEqual([
      'session.prompt', 'session.dequeue', 'session.steer', 'session.steer.attachments',
      'session.interrupt', 'approval.respond', 'input.respond', 'session.provider.switch',
    ])
    expect(commands().every(([, p]) => p.machineId === scope.machineId && p.command.sessionId === scope.sessionId)).toBe(true)
  })

  it('translates normal root dot to the gateway root and refuses unsafe host paths', async () => {
    bridge.invoke.mockImplementation(async (method) => method === 'machines.list' ? machines : success({
      path: '', entries: [{ name: 'host.ts', path: 'host.ts', kind: 'file', size: 12 }], nextCursor: null, error: null,
    }))
    const client = createSessionClient(scope)
    expect(await client.invoke('fs.list', { sessionId: scope.sessionId, path: '.' })).toEqual([{ name: 'host.ts', type: 'file', size: 12 }])
    expect(bridge.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ machineId: 'host-a', query: { op: 'files.list', sessionId: 'sess_same', path: '' } })
    await expect(client.invoke('fs.list', { sessionId: scope.sessionId, path: 'C:/client' })).rejects.toThrow()
    expect(bridge.invoke.mock.calls.filter(([method]) => method === 'machines.query')).toHaveLength(1)
  })

  it('retains the exact unknown receipt and only queries its original status', async () => {
    bridge.invoke.mockImplementation(async (method) => {
      if (method === 'machines.list') return machines
      if (method === 'machines.command') throw new Error('response lost after execution')
      return { ok: false, error: { code: 'not_found', message: 'evicted result' } }
    })
    const client = createSessionClient(scope)
    await expect(client.invoke('command.dispatch', { command: { type: 'turn.start', sessionId: scope.sessionId, text: 'once' } })).rejects.toThrow('response lost')
    const original = client.receipt()!
    await expect(client.checkReceipt()).rejects.toThrow('outcome is unknown')
    await expect(client.invoke('command.dispatch', { command: { type: 'turn.interrupt', sessionId: scope.sessionId } })).rejects.toThrow('unconfirmed')
    expect(readReceipt(scope.machineId, scope.sessionId)).toEqual(original)
    expect(commands()).toHaveLength(1)
    expect(bridge.invoke.mock.calls.filter(([method]) => method === 'machines.query')[0]?.[1]).toMatchObject({
      machineId: 'host-a', query: { op: 'command.status', idempotencyKey: original.command.idempotencyKey },
    })
  })

  it('uses the host paste destination and never grants authority to a generated client path', async () => {
    bridge.invoke.mockImplementation(async (method) => method === 'machines.list' ? machines : success({ path: 'pastes/host-owned.txt', bytesWritten: 12 }))
    const result = await createSessionClient(scope).invoke('fs.writeTextFile', { sessionId: scope.sessionId, path: 'C:/client-generated.txt', content: 'pasted bytes' })
    expect(result).toEqual({ path: 'pastes/host-owned.txt', bytesWritten: 12 })
    expect(commands()[0]?.[1]).toMatchObject({ machineId: 'host-a', command: { op: 'pastes.stage', sessionId: scope.sessionId, text: 'pasted bytes' } })
    expect(commands()[0]?.[1].command).not.toHaveProperty('path')
  })

  it('reports replay gaps as incomplete even when a later terminal claims completion', async () => {
    const received: SessionEventFrame[] = []
    const dispose = createSessionClient(scope).subscribe('session.events', { sessionId: scope.sessionId }, (frame) => received.push(frame as SessionEventFrame))
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalled())
    const emit = (frame: unknown) => frames({ machineId: 'host-a', message: { type: 'events.desktop.frame', sessionId: scope.sessionId, frame } })
    emit({ kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: 1 })
    emit({ kind: 'chunk', events: [event(1)] })
    emit({ kind: 'terminal', replayOutcome: 'complete', seq: 1, liveTurnId: null, reason: null })
    expect(received).toEqual([expect.objectContaining({ replayDone: true, replayOutcome: 'incomplete' })])
    dispose()
  })

  it('converts seq zero and more than 2,000 journal rows with an explicit empty-resume terminal', async () => {
    const client = createSessionClient(scope)
    const received: SessionEventFrame[] = []
    const dispose = client.subscribe('session.events', { sessionId: scope.sessionId }, (frame) => received.push(frame as SessionEventFrame))
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalled())
    const emit = (frame: unknown) => frames({ machineId: 'host-a', message: { type: 'events.desktop.frame', sessionId: scope.sessionId, frame } })
    emit({ kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: 2099 })
    for (let start = 0; start < 2100; start += 128)
      emit({ kind: 'chunk', events: Array.from({ length: Math.min(128, 2100 - start) }, (_, i) => event(start + i)) })
    emit({ kind: 'terminal', replayOutcome: 'complete', seq: 2099, liveTurnId: null, reason: null })
    expect(received.flatMap((frame) => frame.events ?? [])).toHaveLength(2100)
    expect((received[0]?.events?.[0] as JournalEvent).seq).toBe(0)
    expect(received.at(-1)).toMatchObject({ replayDone: true, replayMode: 'full', replayOutcome: 'complete', liveTurnId: null })
    dispose()
    received.length = 0
    const resume = client.subscribe('session.events', { sessionId: scope.sessionId, fromSeq: 2099 }, (frame) => received.push(frame as SessionEventFrame))
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(2))
    emit({ kind: 'start', replayMode: 'resume', fromSeq: 2099, throughSeq: 2099 })
    emit({ kind: 'terminal', replayOutcome: 'complete', seq: 2099, liveTurnId: null, reason: null })
    expect(received).toEqual([expect.objectContaining({ replayDone: true, replayMode: 'resume', seq: 2099 })])
    resume()
  })

  it('clears watched host caches and rejects late stream delivery after removal', async () => {
    const client = createSessionClient(scope)
    const store = transcriptStore(client.viewKey)
    const history = historyJournal(store)
    history.add(event(0, 'private host row'))
    history.publish()
    const changed = vi.fn()
    const unwatch = store.subscribe(changed)
    const received = vi.fn()
    const dispose = client.subscribe('session.events', { sessionId: scope.sessionId }, received)
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalled())
    machines = [desktopMachineFixture('host-b')]
    await refreshMachineInventory()
    expect(store.getSnapshot()).toEqual([])
    expect(changed).toHaveBeenCalled()
    history.add(event(1, 'late private row'))
    history.publish()
    frames({ machineId: 'host-a', message: { type: 'events.desktop.frame', sessionId: scope.sessionId, frame: { kind: 'live', event: event(1) } } })
    expect(store.getSnapshot()).toEqual([])
    expect(received).not.toHaveBeenCalled()
    expect(client.readOnly).toBe(true)
    dispose(); unwatch()
  })

  it('updates capability reasons inside consumers when the owning machine goes offline', async () => {
    function Status() { const client = useSessionClient(); return <p>{client.availability}</p> }
    render(<SessionClientProvider scope={scope}><Status /></SessionClientProvider>)
    await screen.findByText('available')
    machines = [{ ...desktopMachineFixture(), status: 'offline' as never }]
    await act(() => refreshMachineInventory())
    expect(screen.getByText('offline')).toBeVisible()
    expect(createSessionClient(scope).capabilityReason('session.prompt')).toMatch(/Reconnect/)
  })

  it('invalidates host presentation when a connected project grant shrinks', async () => {
    machines = [{ ...desktopMachineFixture(), allProjects: false, projectIds: ['project-a', 'project-b'] }]
    await refreshMachineInventory()
    const client = createSessionClient(scope)
    const epoch = client.authorizationEpoch
    const store = transcriptStore(client.viewKey)
    const history = historyJournal(store)
    history.add(event(0, 'authorized project row')); history.publish()
    machines = [{ ...desktopMachineFixture(), allProjects: false, projectIds: ['project-b'] }]
    await refreshMachineInventory()
    expect(client.authorizationEpoch).toBeGreaterThan(epoch)
    expect(store.getSnapshot()).toEqual([])
  })
})
