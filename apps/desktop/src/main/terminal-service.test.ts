import { describe, expect, it, vi } from 'vitest'
import {
  TerminalService,
  ptyUnavailableReason,
  type PtyFactory,
  type PtyLike,
} from './terminal-service'

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
    pid: Math.floor(Math.random() * 100000),
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

  it('write/resize delegate to the pty; resize of dead session is safe', () => {
    const { service, ptys } = makeService()
    service.create('t3', '.')
    service.write('t3', 'ls\r')
    service.resize('t3', 120, 30)
    service.kill('t3')
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
