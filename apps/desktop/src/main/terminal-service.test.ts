// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import {
  TerminalService,
  ptyUnavailableReason,
  type PtyFactory,
  type PtyLike,
} from './terminal-service'

// Fake PTYs never authorize killing any real host PID in these tests.
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
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

type FakePty = PtyLike & {
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: (code?: number) => void
}

function fakePty(): FakePty {
  const dataCbs: ((d: string) => void)[] = []
  const exitCbs: ((code: number) => void)[] = []
  const pty = {
    pid: 1234,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb: (d: string) => void): void => {
      dataCbs.push(cb)
    },
    onExit: (cb: (code: number) => void): void => {
      exitCbs.push(cb)
    },
    emitData: (data: string): void => dataCbs.forEach((cb) => cb(data)),
    emitExit: (code = 0): void => exitCbs.forEach((cb) => cb(code)),
  }
  return pty
}

function makeService() {
  const ptys: FakePty[] = []
  const factory: PtyFactory = (file, args, options) => {
    void file
    void args
    void options
    const pty = fakePty()
    ptys.push(pty)
    return pty
  }
  const dataEvents: { id: string; data: string }[] = []
  const exits: string[] = []
  const service = new TerminalService(
    {
      onData: (id, data) => dataEvents.push({ id, data }),
      onExit: (id) => exits.push(id),
    },
    factory,
  )
  return { service, ptys, dataEvents, exits }
}

describe('TerminalService', () => {
  it('creates sessions with the platform shell and forwards data', () => {
    const { service, ptys, dataEvents } = makeService()
    service.create('t1', 'D:\\proj')
    expect(ptys).toHaveLength(1)
    expect(service.has('t1')).toBe(true)

    ptys[0]?.emitData('hello')
    expect(dataEvents).toEqual([{ id: 't1', data: 'hello' }])
  })

  it('keeps a bounded scrollback ring and replays it', () => {
    const { service, ptys } = makeService()
    service.create('t2', '.')
    const chunk = 'x'.repeat(600 * 1024)
    ptys[0]?.emitData(chunk)
    ptys[0]?.emitData(chunk)
    // Two 600KB chunks → ring keeps only the last 1MB.
    expect(service.replay('t2').length).toBeLessThanOrEqual(1024 * 1024)
    expect(service.replay('missing')).toBe('')
  })

  it('write/resize delegate to the pty; resize of dead session is safe', async () => {
    const { service, ptys } = makeService()
    service.create('t3', '.')
    service.write('t3', 'ls\r')
    service.resize('t3', 120, 30)
    await service.kill('t3')
    service.resize('t3', 80, 24) // dead — must not throw
    const pty = ptys[0]
    expect(pty?.write.mock.calls[0]).toEqual(['ls\r'])
    expect(pty?.resize.mock.calls[0]).toEqual([120, 30])
    expect(pty?.kill.mock.calls).toHaveLength(1)
    expect(service.has('t3')).toBe(false)
  })

  it('create is idempotent per id', () => {
    const { service, ptys } = makeService()
    service.create('dup', '.')
    service.create('dup', '.')
    expect(ptys).toHaveLength(1)
  })

  it('forwards pty exit so the host can name it instead of hanging blank', () => {
    const { service, ptys, exits } = makeService()
    service.create('t4', '.')
    ptys[0]?.emitExit()
    expect(exits).toEqual(['t4'])
  })

  it('closes all native handles and child trees exactly once and refuses late creation', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    vi.mocked(exec).mockClear()
    const { service, ptys } = makeService()
    service.create('one', '.')
    service.create('two', '.')
    await service.close()
    await service.close()
    expect(ptys.map((pty) => pty.kill.mock.calls.length)).toEqual([1, 1])
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec).toHaveBeenCalledWith('taskkill /PID 1234 /T /F', expect.any(Function))
    expect(service.has('one')).toBe(false)
    expect(service.has('two')).toBe(false)
    expect(() => service.create('late', '.')).toThrow('Ari is shutting down')
    expect(ptys).toHaveLength(2)
  })

  it('releases an exited terminal without attempting to kill a stale PID', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    vi.mocked(exec).mockClear()
    const { service, ptys } = makeService()
    service.create('exited', '.')
    ptys[0]!.emitExit()
    await service.close()
    expect(ptys[0]!.kill).toHaveBeenCalledOnce()
    expect(exec).not.toHaveBeenCalled()
  })

  it('retains the native shell until tree enumeration completes and shutdown awaits a prior kill', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    let finish: (() => void) | undefined
    vi.mocked(exec).mockImplementation((...args) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void
      finish = () => {
        callback(null, '', '')
      }
      return {} as ReturnType<typeof exec>
    })
    const { service, ptys } = makeService()
    service.create('tree', '.')
    // Like ConPTY, a backend can provide its PID after asynchronous startup.
    ptys[0]!.pid = 5678
    const killing = service.kill('tree')
    expect(exec).toHaveBeenLastCalledWith('taskkill /PID 5678 /T /F', expect.any(Function))
    expect(ptys[0]!.kill).not.toHaveBeenCalled()
    expect(service.has('tree')).toBe(false)
    let closed = false
    const closing = service.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    finish!()
    await killing
    await closing
    expect(ptys[0]!.kill).toHaveBeenCalledOnce()
    expect(closed).toBe(true)
    await service.close()
    expect(ptys[0]!.kill).toHaveBeenCalledOnce()
  })

  it.each(['callback', 'launch'])(
    'releases the native handle when tree cleanup fails at %s',
    async (failure) => {
      vi.stubGlobal('process', { ...process, platform: 'win32' })
      vi.mocked(exec).mockImplementation((...args) => {
        if (failure === 'launch') throw new Error('could not start taskkill')
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void
        callback(new Error('already gone'), '', '')
        return {} as ReturnType<typeof exec>
      })
      const { service, ptys } = makeService()
      service.create('failed', '.')
      await service.kill('failed')
      expect(ptys[0]!.kill).toHaveBeenCalledOnce()
      await service.close()
    },
  )

  it('releases a PTY that has not obtained a PID without targeting PID zero', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    vi.mocked(exec).mockClear()
    const { service, ptys } = makeService()
    service.create('starting', '.')
    ptys[0]!.pid = 0
    await service.close()
    expect(exec).not.toHaveBeenCalled()
    expect(ptys[0]!.kill).toHaveBeenCalledOnce()
  })
})

describe('ptyUnavailableReason', () => {
  it('quotes a load failure so the pane can name the real cause', () => {
    expect(ptyUnavailableReason('could not find @lydell/node-pty-win32-x64')).toBe(
      'terminal backend unavailable — could not find @lydell/node-pty-win32-x64',
    )
  })

  it('reports a cold start separately, since that one does resolve', () => {
    expect(ptyUnavailableReason(null)).toBe('terminal backend still loading')
  })
})
