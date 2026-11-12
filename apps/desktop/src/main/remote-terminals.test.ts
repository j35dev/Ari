// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import type { RemoteCommand } from '@ari/contracts/remote'
import type { RemoteCaller } from '@ari/remote-gateway/host'
import { RemoteTerminals } from './remote-terminals'
import type { PtySpawnOptions } from './terminal-service'

const caller = { deviceId: 'phone', projectIds: ['p'], allowTerminal: true }
const envelope = { sessionId: 's', clientCommandId: 'cmd', idempotencyKey: 'unique-command-key' }
const managers: RemoteTerminals[] = []
// These PTYs are fakes; no test owns a host PID.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  exec: vi.fn(),
}))
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  vi.mocked(exec).mockImplementation((...args) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
    callback(null, '', '')
    return {} as ReturnType<typeof exec>
  })
})
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function setup(allowed: (deviceId: string, projectId: string) => boolean = () => true) {
  const shells: {
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    data: (text: string) => void
    exit: () => void
  }[] = []
  const spawned: PtySpawnOptions[] = []
  const manager = new RemoteTerminals((_file, _args, options) => {
    spawned.push(options)
    let data: (text: string) => void = () => undefined
    let exit: () => void = () => undefined
    const pty = {
      pid: 2147483647,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (cb: (data: string) => void) => {
        data = cb
      },
      onExit: (cb: (code: number) => void) => {
        exit = () => cb(0)
      },
    }
    shells.push({
      write: pty.write,
      resize: pty.resize,
      kill: pty.kill,
      data: (text) => data(text),
      exit: () => exit(),
    })
    return pty
  }, allowed)
  managers.push(manager)
  const create = (authorized: RemoteCaller = caller) => {
    const result = manager.execute(
      authorized,
      { ...envelope, op: 'terminal.create', cols: 80, rows: 24 },
      { projectId: 'p', workspace: '/trusted/workspace' },
    )
    if (!result.ok) throw new Error(result.message)
    return (result.result as { terminalId: string }).terminalId
  }
  const command = (
    op: 'terminal.write' | 'terminal.resize' | 'terminal.kill',
    terminalId: string,
  ) => ({ ...envelope, op, terminalId, data: 'echo hi\r', cols: 100, rows: 40 }) as RemoteCommand
  return { manager, shells, spawned, create, command }
}

describe('remote terminals', () => {
  it('expires managed shells while preserving local shells for the same device', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { manager, shells, create } = setup()
    const managed = { ...caller, managedLeaseExpiresAt: 1500 }
    const id = create(managed)
    const local = create()
    expect(manager.read(caller, 's', id, 0)).toBeNull()
    expect(manager.read(managed, 's', local, 0)).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
    expect(shells[1]?.kill).not.toHaveBeenCalled()
    expect(manager.read(caller, 's', local, 0)).not.toBeNull()
  })

  it('renews only the matching managed device/session/project terminal before expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { manager, shells, create } = setup()
    const managed = { ...caller, managedLeaseExpiresAt: 1500 }
    const id = create(managed)
    await vi.advanceTimersByTimeAsync(1000)
    const renewed = { ...managed, managedLeaseExpiresAt: 3500 }
    expect(manager.read({ ...renewed, deviceId: 'other' }, 's', id, 0)).toBeNull()
    expect(manager.read(renewed, 'another-session', id, 0)).toBeNull()
    expect(manager.read({ ...renewed, projectIds: ['other'] }, 's', id, 0)).toBeNull()
    expect(manager.read(renewed, 's', id, 0)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(shells[0]?.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
    expect(manager.read({ ...renewed, managedLeaseExpiresAt: 10000 }, 's', id, 0)).toBeNull()
  })

  it('closes managed shells on connector stop without closing local shells', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { manager, shells, create } = setup()
    create({ ...caller, managedLeaseExpiresAt: 10000 })
    create()
    await manager.closeManaged()
    await vi.advanceTimersByTimeAsync(0)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
    expect(shells[1]?.kill).not.toHaveBeenCalled()
  })

  it('rejects an expired lease at execution and does not renew a shell after its prior lease expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { manager, shells, create } = setup()
    const managed = { ...caller, managedLeaseExpiresAt: 500 }
    const id = create(managed)
    vi.setSystemTime(501)
    expect(manager.read({ ...managed, managedLeaseExpiresAt: 5000 }, 's', id, 0)).toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
    expect(manager.execute(managed, { ...envelope, op: 'terminal.create', cols: 80, rows: 24 }, { projectId: 'p', workspace: '.' })).toMatchObject({ ok: false, code: 'access_revoked' })
  })

  it('requires a desktop grant and preserves ownership for every operation', () => {
    const { manager, shells, create, command } = setup()
    expect(
      manager.execute(
        { ...caller, allowTerminal: false },
        { ...envelope, op: 'terminal.create', cols: 80, rows: 24 },
        { projectId: 'p', workspace: '.' },
      ),
    ).toMatchObject({ ok: false, code: 'access_revoked' })
    const id = create()
    for (const unauthorized of [
      { ...caller, deviceId: 'other' },
      { ...caller, allowTerminal: false },
    ]) {
      expect(manager.read(unauthorized, 's', id, 0)).toBeNull()
      expect(
        manager.execute(
          unauthorized,
          command('terminal.write', id) as Extract<RemoteCommand, { op: `terminal.${string}` }>,
          { projectId: 'p', workspace: '.' },
        ).ok,
      ).toBe(false)
    }
    expect(manager.read(caller, 'different-session', id, 0)).toBeNull()
    expect(
      manager.execute(
        caller,
        command('terminal.write', id) as Extract<RemoteCommand, { op: `terminal.${string}` }>,
        { projectId: 'p', workspace: '.' },
      ).ok,
    ).toBe(true)
    expect(shells[0]?.write).toHaveBeenCalledWith('echo hi\r')
    manager.execute(
      caller,
      command('terminal.resize', id) as Extract<RemoteCommand, { op: `terminal.${string}` }>,
      { projectId: 'p', workspace: '.' },
    )
    expect(shells[0]?.resize).toHaveBeenLastCalledWith(100, 40)
  })

  it('bounds replay, announces reset and exited state, and limits concurrent shells', () => {
    const { manager, shells, create } = setup()
    const id = create()
    create()
    expect(
      manager.execute(
        caller,
        { ...envelope, op: 'terminal.create', cols: 80, rows: 24 },
        { projectId: 'p', workspace: '.' },
      ),
    ).toMatchObject({ ok: false, code: 'rate_limited' })
    shells[0]?.data('x'.repeat(200_000))
    const read = manager.read(caller, 's', id, 0)
    expect(read).toMatchObject({ reset: true, hasMore: true, seq: 101696 })
    expect(read?.data.length).toBe(32768)
    shells[0]?.exit()
    expect(manager.read(caller, 's', id, 200_000)).toMatchObject({ data: '', exited: true })
  })

  it('kills revoked device shells and removes control credentials from child environments', async () => {
    vi.useFakeTimers()
    vi.stubEnv('ARI_CONTROL_TOKEN', 'secret')
    vi.stubEnv('ARI_CLI', 'private-launcher')
    let allowed = true
    const { manager, shells, spawned, create } = setup(() => allowed)
    const id = create()
    expect(spawned[0]?.cwd).toBe('/trusted/workspace')
    expect(spawned[0]?.env['ARI_CONTROL_TOKEN']).toBeUndefined()
    expect(spawned[0]?.env['ARI_CLI']).toBeUndefined()
    allowed = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
    expect(manager.read(caller, 's', id, 0)).toBeNull()
  })

  it('kills device shells when the session project is no longer granted', async () => {
    vi.useFakeTimers()
    let granted = ['p']
    const { shells, create } = setup((_deviceId, projectId) => granted.includes(projectId))
    create()
    vi.advanceTimersByTime(1000)
    expect(shells[0]?.kill).not.toHaveBeenCalled()
    granted = []
    await vi.advanceTimersByTimeAsync(1000)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
  })
})
