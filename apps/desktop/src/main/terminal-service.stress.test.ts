import { describe, expect, it, vi } from 'vitest'
import { TerminalService, type PtyFactory, type PtyLike } from './terminal-service'

const CHUNK_BYTES = 100
const CHUNK_COUNT = 10_000
const SOAK_CHUNK_COUNT = 15_000 // 1.5MB total → forces ring truncation
const MAX_SCROLLBACK = 1024 * 1024

type FakePty = PtyLike & {
  emitData: (data: string) => void
}

function fakePty(): FakePty {
  const dataCbs: ((d: string) => void)[] = []
  return {
    pid: Math.floor(Math.random() * 100000),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb: (d: string) => void): void => {
      dataCbs.push(cb)
    },
    onExit: (_cb: (code: number) => void): void => undefined,
    emitData: (data: string): void => dataCbs.forEach((cb) => cb(data)),
  }
}

function makeService() {
  const ptys: FakePty[] = []
  const factory: PtyFactory = () => {
    const pty = fakePty()
    ptys.push(pty)
    return pty
  }
  const dataEvents: { id: string; data: string }[] = []
  const service = new TerminalService(
    {
      onData: (id, data) => dataEvents.push({ id, data }),
      onExit: () => undefined,
    },
    factory,
  )
  return { service, ptys, dataEvents }
}

/** Deterministic 100-byte chunk carrying its sequence number. */
function chunkOf(i: number): string {
  const prefix = `line-${String(i).padStart(6, '0')}-`
  return prefix + 'x'.repeat(CHUNK_BYTES - prefix.length - 1) + '\n'
}

function spew(pty: FakePty, count: number): string {
  let full = ''
  for (let i = 0; i < count; i += 1) {
    const chunk = chunkOf(i)
    pty.emitData(chunk)
    full += chunk
  }
  return full
}

describe('TerminalService stress', () => {
  it('forwards a synchronous 10k-chunk spew losslessly and keeps scrollback within the 1MB cap', () => {
    const { service, ptys, dataEvents } = makeService()
    service.create('stress', '.')
    const pty = ptys[0]
    expect(pty).toBeDefined()
    if (!pty) return

    const start = performance.now()
    const expected = spew(pty, CHUNK_COUNT)
    const elapsedMs = performance.now() - start

    // Every chunk reached the onData consumer, in order, byte-exact.
    expect(dataEvents).toHaveLength(CHUNK_COUNT)
    expect(dataEvents.map((e) => e.data).join('')).toBe(expected)
    expect(new Set(dataEvents.map((e) => e.id))).toEqual(new Set(['stress']))

    // Ring invariant under the whole stream.
    const replay = service.replay('stress')
    expect(replay.length).toBeLessThanOrEqual(MAX_SCROLLBACK)
    expect(replay).toBe(expected.slice(-MAX_SCROLLBACK))

    // Synchronous in-memory path; generous CI budget guards against
    // accidental per-chunk allocation blowups (e.g. quadratic concat).
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it('soaks past the cap (15k chunks) and truncates the ring to exactly the last 1MB', () => {
    const { service, ptys, dataEvents } = makeService()
    service.create('soak', '.')

    const pty = ptys[0]
    expect(pty).toBeDefined()
    if (!pty) return

    const expected = spew(pty, SOAK_CHUNK_COUNT)

    // No drops even when the ring is discarding history.
    expect(dataEvents).toHaveLength(SOAK_CHUNK_COUNT)

    const replay = service.replay('soak')
    expect(replay.length).toBe(MAX_SCROLLBACK)
    expect(replay).toBe(expected.slice(-MAX_SCROLLBACK))
  })
})
