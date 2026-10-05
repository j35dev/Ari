import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWriter } from './terminal-writer'
afterEach(() => vi.useRealTimers())

describe('terminal input', () => {
  it('batches keystrokes in order and splits bounded writes', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockResolvedValue(undefined)
    const writer = new TerminalWriter(send, vi.fn())
    const first = writer.write('git ')
    const second = writer.write('status\r')
    await vi.advanceTimersByTimeAsync(80)
    await Promise.all([first, second])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toBe('git status\r')
    const large = writer.write('x'.repeat(17000))
    await vi.advanceTimersByTimeAsync(80)
    await large
    expect(send.mock.calls.slice(1).map((args) => (args[0] as string).length)).toEqual([16384, 616])
    writer.dispose()
  })
  it('keeps the failed receipt and blocks later input until an explicit retry', async () => {
    vi.useFakeTimers()
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValue(undefined)
    const error = vi.fn()
    const writer = new TerminalWriter(send, error)
    const pending = writer.write('npm test\r').catch((failure: unknown) => failure)
    await vi.advanceTimersByTimeAsync(80)
    expect(await pending).toBeInstanceOf(Error)
    await expect(writer.write('rm file\r')).rejects.toThrow('Retry the pending')
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(1)
    await writer.retry()
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
    expect(error).toHaveBeenCalledTimes(1)
    writer.dispose()
  })
  it('keeps input blocked when the explicit retry also loses its acknowledgement', async () => {
    vi.useFakeTimers()
    const send = vi.fn().mockRejectedValue(new Error('lost acknowledgement'))
    const writer = new TerminalWriter(send, vi.fn())
    const pending = writer.write('deploy\r').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(80)
    await pending
    await expect(writer.retry()).rejects.toThrow('still unacknowledged')
    await expect(writer.write('another command\r')).rejects.toThrow('Retry the pending')
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
    writer.dispose()
  })
})
