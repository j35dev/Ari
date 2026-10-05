import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteCommand } from '@ari/contracts/remote'
import { RemoteTerminals } from './remote-terminals'
import type { PtySpawnOptions } from './terminal-service'

const caller = { deviceId: 'phone', projectIds: ['p'], allowTerminal: true }
const envelope = { sessionId: 's', clientCommandId: 'cmd', idempotencyKey: 'unique-command-key' }
const managers: RemoteTerminals[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function setup(allowed = () => true) {
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
  const create = () => {
    const result = manager.execute(
      caller,
      { ...envelope, op: 'terminal.create', cols: 80, rows: 24 },
      '/trusted/workspace',
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
  it('requires a desktop grant and preserves ownership for every operation', () => {
    const { manager, shells, create, command } = setup()
    expect(
      manager.execute(
        { ...caller, allowTerminal: false },
        { ...envelope, op: 'terminal.create', cols: 80, rows: 24 },
        '.',
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
          '.',
        ).ok,
      ).toBe(false)
    }
    expect(manager.read(caller, 'different-session', id, 0)).toBeNull()
    expect(
      manager.execute(
        caller,
        command('terminal.write', id) as Extract<RemoteCommand, { op: `terminal.${string}` }>,
        '.',
      ).ok,
    ).toBe(true)
    expect(shells[0]?.write).toHaveBeenCalledWith('echo hi\r')
    manager.execute(
      caller,
      command('terminal.resize', id) as Extract<RemoteCommand, { op: `terminal.${string}` }>,
      '.',
    )
    expect(shells[0]?.resize).toHaveBeenLastCalledWith(100, 40)
  })

  it('bounds replay, announces reset and exited state, and limits concurrent shells', () => {
    const { manager, shells, create } = setup()
    const id = create()
    create()
    expect(
      manager.execute(caller, { ...envelope, op: 'terminal.create', cols: 80, rows: 24 }, '.'),
    ).toMatchObject({ ok: false, code: 'rate_limited' })
    shells[0]?.data('x'.repeat(200_000))
    const read = manager.read(caller, 's', id, 0)
    expect(read).toMatchObject({ reset: true, hasMore: true, seq: 101696 })
    expect(read?.data.length).toBe(32768)
    shells[0]?.exit()
    expect(manager.read(caller, 's', id, 200_000)).toMatchObject({ data: '', exited: true })
  })

  it('kills revoked device shells and removes control credentials from child environments', () => {
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
    vi.advanceTimersByTime(1000)
    expect(shells[0]?.kill).toHaveBeenCalledOnce()
    expect(manager.read(caller, 's', id, 0)).toBeNull()
  })
})
