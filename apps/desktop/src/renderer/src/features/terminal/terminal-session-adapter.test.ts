import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionClient } from '../session/session-client'
import { readReceipt } from '../machines/remote-client'
import { createTerminalSessionAdapter } from './terminal-session-adapter'
import { findTerminalTab, openTerminalTab, resetTerminalDock } from './terminal-dock'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), allowed: true }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: mocks.invoke, subscribe: () => () => undefined } }))
vi.mock('../session/session-machine-access', () => ({
  assertMachineOperation: async () => 0, machineEpoch: () => 0,
  sessionMachine: () => ({ status: 'connected', allowTerminal: mocks.allowed }),
  machineCapabilityReason: () => null, observeMachineInventory: () => () => undefined,
  machineInventoryRevision: () => 0, refreshMachineInventory: async () => undefined,
}))

const owner = { kind: 'remote' as const, machineId: 'machine', sessionId: 'sess_host' }
const client = () => createTerminalSessionAdapter(createSessionClient(owner))
const key = (id: string) => `terminal:sess_host:${id}`

describe('normal host terminal adapter', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTerminalDock()
    mocks.allowed = true
    mocks.invoke.mockReset()
    mocks.invoke.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'machines.command') {
        const { command } = params as { command: { op: string } }
        return { ok: true, result: command.op === 'terminal.create' ? { terminalId: 'host-pty' }
          : command.op === 'terminal.kill' ? { killed: true } : { accepted: true } }
      }
      throw new Error('unexpected IPC')
    })
  })

  it('creates on the owning host and remounts without a second create or local cwd', async () => {
    const id = openTerminalTab({ title: 'shell', cwd: '/local-looking-path', owner })
    await client().invoke('terminal.create', { id, cwd: '/local-looking-path' })
    expect(findTerminalTab(id)?.hostTerminalId).toBe('host-pty')
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe('machines.command')
    expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({ machineId: 'machine', command: {
      op: 'terminal.create', sessionId: 'sess_host', cols: 80, rows: 24,
    } })
    expect((mocks.invoke.mock.calls[0]?.[1] as { command: object }).command).not.toHaveProperty('cwd')
    await client().invoke('terminal.create', { id, cwd: '/another-path' })
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('refuses foreign tab ownership and withdrawn terminal access before dispatch', async () => {
    const foreign = openTerminalTab({ title: 'foreign', cwd: '.', owner: { ...owner, machineId: 'other' } })
    await expect(client().invoke('terminal.create', { id: foreign, cwd: '.' })).rejects.toThrow('another machine')
    const id = openTerminalTab({ title: 'shell', cwd: '.', owner })
    mocks.allowed = false
    await expect(client().invoke('terminal.create', { id, cwd: '.' })).rejects.toThrow('granted')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('checks an uncertain create with its original key and never dispatches it again', async () => {
    mocks.invoke.mockRejectedValue(new Error('connection lost after dispatch'))
    const id = openTerminalTab({ title: 'shell', cwd: '.', owner })
    await expect(client().invoke('terminal.create', { id, cwd: '.' })).rejects.toThrow('connection lost')
    const receipt = readReceipt('machine', key(id))!
    expect(receipt.command.op).toBe('terminal.create')
    mocks.invoke.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'history lost' } })
    await expect(client().invoke('terminal.create', { id, cwd: '.' })).rejects.toThrow()
    expect(mocks.invoke.mock.calls[1]?.[0]).toBe('machines.query')
    expect(mocks.invoke.mock.calls[1]?.[1]).toMatchObject({ query: {
      op: 'command.status', idempotencyKey: receipt.command.idempotencyKey,
    } })
    expect(readReceipt('machine', key(id))?.command.idempotencyKey).toBe(receipt.command.idempotencyKey)
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
  })

  it('preserves the receipt when storing a confirmed host reference fails', async () => {
    const id = openTerminalTab({ title: 'shell', cwd: '.', owner })
    const original = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (name, value) {
      if (name === 'ari.terminal.dock' && value.includes('host-pty')) throw new Error('storage full')
      original.call(this, name, value)
    })
    try {
      await expect(client().invoke('terminal.create', { id, cwd: '.' })).rejects.toThrow('storage full')
      expect(readReceipt('machine', key(id))?.command.op).toBe('terminal.create')
      expect(findTerminalTab(id)?.hostTerminalId).toBeUndefined()
    } finally { spy.mockRestore() }
    mocks.invoke.mockResolvedValue({ ok: true, result: { terminalId: 'host-pty' } })
    await client().checkTerminal(id)
    expect(findTerminalTab(id)?.hostTerminalId).toBe('host-pty')
    expect(readReceipt('machine', key(id))).toBeNull()
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(1)
  })

  it('blocks later terminal input after an unknown write until a read-only status check', async () => {
    const id = openTerminalTab({ title: 'shell', cwd: '.', owner })
    const adapter = client()
    await adapter.invoke('terminal.create', { id, cwd: '.' })
    mocks.invoke.mockRejectedValue(new Error('write response lost'))
    await expect(adapter.invoke('terminal.write', { id, data: 'dangerous once\r' })).rejects.toThrow('response lost')
    const receipt = readReceipt('machine', key(id))!
    await expect(adapter.invoke('terminal.write', { id, data: 'more input' })).rejects.toThrow('unconfirmed')
    expect(mocks.invoke.mock.calls.filter(([method]) => method === 'machines.command')).toHaveLength(2)
    mocks.invoke.mockResolvedValue({ ok: true, result: { accepted: true } })
    await adapter.checkTerminal(id)
    expect(mocks.invoke.mock.calls.at(-1)?.[0]).toBe('machines.query')
    expect(mocks.invoke.mock.calls.at(-1)?.[1]).toMatchObject({ query: { idempotencyKey: receipt.command.idempotencyKey } })
    expect(readReceipt('machine', key(id))).toBeNull()
  })
})
