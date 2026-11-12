import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostDraftClient, type HostDraftSelection } from './session-draft-client'
import { desktopMachineFixture } from '../machines/fixtures.test-support'
import { refreshMachineInventory } from './session-machine-access'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => {}) }))
vi.mock('../../lib/rpc', () => ({ rpc: bridge }))
const selection: HostDraftSelection = {
  projectId: 'host-project', title: 'Draft task', driverKind: 'codex', modelId: 'gpt-6.1-sol',
  effort: 'high', permissionMode: 'ask', workspaceMode: 'isolated', workspaceToken: 'host-workspace-token',
}
const commands = () => bridge.invoke.mock.calls.filter(([method]) => method === 'machines.command')
const success = (result: unknown) => ({ ok: true, result })
beforeEach(async () => {
  localStorage.clear()
  bridge.invoke.mockReset()
  bridge.invoke.mockImplementation(async (method, params) => {
    if (method === 'machines.list') return [desktopMachineFixture()]
    if (method === 'machines.command') return success(params.command.op === 'session.desktop.create' ? { sessionId: 'sess_created' } : { accepted: true })
    throw new Error(`Unexpected local call ${method}`)
  })
  await refreshMachineInventory()
})

describe('first-send host draft facade', () => {
  it('creates nothing during selection and persists the exact created scope before clearing its receipt', async () => {
    const draft = createHostDraftClient('host-a', 'stable-draft')
    expect(commands()).toHaveLength(0)
    expect(draft.createdScope()).toBeNull()
    const scope = await draft.create(selection)
    expect(scope).toEqual({ kind: 'remote', machineId: 'host-a', sessionId: 'sess_created' })
    expect(draft.receipt()).toBeNull()
    expect(draft.createdScope()).toEqual(scope)
    expect(commands()[0]?.[1]).toMatchObject({ machineId: 'host-a', command: { op: 'session.desktop.create', ...selection } })
    const remount = createHostDraftClient('host-a', 'stable-draft')
    expect(await remount.create(selection)).toEqual(scope)
    expect(commands()).toHaveLength(1)
    await remount.firstPrompt(scope, 'first message')
    await createHostDraftClient('host-a', 'stable-draft').firstPrompt(scope, 'first message')
    expect(commands()).toHaveLength(2)
  })

  it('retains creation evidence after reference storage fails and checks without recreating', async () => {
    const draft = createHostDraftClient('host-a', 'storage-draft')
    const write = Storage.prototype.setItem
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('ari.machines.draft-session.v1:')) throw new Error('reference storage full')
      return write.call(this, key, value)
    })
    try { await expect(draft.create(selection)).rejects.toThrow('storage full') }
    finally { fail.mockRestore() }
    const original = draft.receipt()!
    expect(original.command.op).toBe('session.desktop.create')
    bridge.invoke.mockImplementation(async (method) => method === 'machines.list' ? [desktopMachineFixture()] : success({ sessionId: 'sess_created' }))
    expect(await draft.checkCreation()).toEqual({ kind: 'remote', machineId: 'host-a', sessionId: 'sess_created' })
    expect(commands()).toHaveLength(1)
    expect(bridge.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ query: { op: 'command.status', idempotencyKey: original.command.idempotencyKey } })
    expect(draft.receipt()).toBeNull()
  })

  it('locks uncertain creation and uncertain first prompt to their original host and command keys', async () => {
    const draft = createHostDraftClient('host-a', 'lost-draft')
    bridge.invoke.mockImplementation(async (method) => {
      if (method === 'machines.list') return [desktopMachineFixture()]
      if (method === 'machines.command') throw new Error('completion lost')
      return { ok: false, error: { code: 'not_found', message: 'not retained' } }
    })
    await expect(draft.create(selection)).rejects.toThrow('lost')
    const original = draft.receipt()!
    await expect(draft.create(selection)).rejects.toThrow('unconfirmed')
    await expect(draft.checkCreation()).rejects.toThrow('outcome is unknown')
    expect(draft.receipt()).toEqual(original)
    expect(commands()).toHaveLength(1)
    bridge.invoke.mockImplementation(async (method) => method === 'machines.list' ? [desktopMachineFixture()] : success({ sessionId: 'sess_created' }))
    const scope = await draft.checkCreation()
    bridge.invoke.mockImplementation(async (method) => {
      if (method === 'machines.list') return [desktopMachineFixture()]
      if (method === 'machines.command') throw new Error('prompt lost')
      return { ok: false, error: { code: 'not_found', message: 'not retained' } }
    })
    await expect(draft.firstPrompt(scope, 'once')).rejects.toThrow('lost')
    await expect(draft.firstPrompt(scope, 'once')).rejects.toThrow('unconfirmed')
    await expect(draft.checkPrompt(scope)).rejects.toThrow('outcome is unknown')
    await expect(draft.firstPrompt({ ...scope, kind: 'remote', machineId: 'host-b' }, 'other host')).rejects.toThrow('another machine')
    expect(commands()).toHaveLength(2)
    expect(await draft.create(selection)).toEqual(scope)
    expect(commands()).toHaveLength(2)
  })
})
