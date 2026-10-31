import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepositoryGit } from './repository-git'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

function processDouble() {
  const child = new EventEmitter()
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', null)
      return true
    }),
  })
  const process = child as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  mocks.spawn.mockReturnValue(process)
  return process
}

beforeEach(() => mocks.spawn.mockReset())
afterEach(() => vi.useRealTimers())

describe('RepositoryGit', () => {
  it('passes internal argv without a shell and preserves stdin/UTF-8 output', async () => {
    const child = processDouble()
    const input: string[] = []
    child.stdin.on('data', (chunk: Buffer) => input.push(chunk.toString()))
    const request = new RepositoryGit('/project').run(['hash-object', '--stdin'], {
      input: '日本語',
    })
    child.stdout.emit('data', Buffer.from('日本語\n'))
    child.emit('close', 0)
    expect(await request).toEqual({ ok: true, value: '日本語\n' })
    expect(input.join('')).toBe('日本語')
    expect(mocks.spawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['hash-object', '--stdin']),
      expect.any(Object),
    )
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: '/project',
      shell: false,
      windowsHide: true,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })
  })

  it('stops collecting oversized output and terminates the process', async () => {
    const child = processDouble()
    const request = new RepositoryGit('/project').run(['diff'], { maxBytes: 2 })
    child.stdout.emit('data', Buffer.from('too much'))
    expect(await request).toMatchObject({ ok: false, error: { code: 'too-large' } })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('returns timeout failure rather than leaving a process running', async () => {
    vi.useFakeTimers()
    const child = processDouble()
    const request = new RepositoryGit('/project').run(['fetch'], { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await request).toMatchObject({
      ok: false,
      error: { code: 'failed', message: 'Git operation timed out.' },
    })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('never starts an already-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(
      await new RepositoryGit('/project').run(['status'], { signal: controller.signal }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('classifies in-flight abort errors and missing executables', async () => {
    const child = processDouble()
    const controller = new AbortController()
    const request = new RepositoryGit('/project').run(['status'], { signal: controller.signal })
    controller.abort()
    child.emit('error', Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))
    expect(await request).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    const missing = processDouble()
    const failure = new RepositoryGit('/project').run(['status'])
    missing.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await failure).toMatchObject({ ok: false, error: { code: 'missing-tool' } })
  })

  it('allows exit one only for explicitly optional reads', async () => {
    const child = processDouble()
    const request = new RepositoryGit('/project').run(['config', '--get', 'missing'], {
      allowExitOne: true,
    })
    child.emit('close', 1)
    expect(await request).toEqual({ ok: true, value: '' })
    const failed = processDouble()
    const failure = new RepositoryGit('/project').run(['commit'])
    failed.emit('close', 1)
    expect(await failure).toMatchObject({ ok: false, error: { code: 'failed' } })
  })
})
