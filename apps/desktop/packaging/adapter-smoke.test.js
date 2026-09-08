// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { smokeBundledAdapter } from './after-pack.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}))

let child
beforeEach(() => {
  child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = vi.fn()
  vi.mocked(spawn).mockReturnValue(child)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

const smoke = () => smokeBundledAdapter('electron', 'adapter.js', {}, '.', 100)

describe('packaged ACP initialization smoke', () => {
  it('accepts a successful, split initialize response after startup logs', async () => {
    const result = smoke()
    child.stdout.write('startup log\n{"jsonrpc":"2.0","id":1,"result":')
    child.stdout.write('{"protocolVersion":1}}\n')
    await expect(result).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it.each([
    [{ id: 1, error: { code: -32603, message: 'missing binary' } }, 'rejected initialize'],
    [{ id: 1, result: {} }, 'invalid initialize'],
    [{ id: 1, result: { protocolVersion: 999 } }, 'invalid initialize'],
  ])('rejects broken initialize replies: %j', async (reply, message) => {
    const result = smoke()
    child.stdout.write(`${JSON.stringify(reply)}\n`)
    await expect(result).rejects.toThrow(message)
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('fails on stalled initialization, even if other requests return', async () => {
    vi.useFakeTimers()
    const result = expect(smoke()).rejects.toThrow('timed out')
    child.stdout.write('{"id":2,"result":{"protocolVersion":1}}\n')
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('bounds unterminated stdout', async () => {
    const result = smoke()
    child.stdout.write('x'.repeat(1024 * 1024 + 1))
    await expect(result).rejects.toThrow('exceeded 1 MiB')
  })

  it.each(['error', 'stdin', 'close'])('rejects %s failures', async (kind) => {
    const result = smoke()
    if (kind === 'stdin') child.stdin.emit('error', new Error('broken pipe'))
    else if (kind === 'error') child.emit('error', new Error('cannot spawn'))
    else child.emit('close', 1)
    await expect(result).rejects.toThrow()
    expect(child.kill).toHaveBeenCalledOnce()
  })
})
