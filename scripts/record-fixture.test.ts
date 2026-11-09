import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordFixture } from './record-fixture'
import type { AdapterSession } from '../packages/providers/src/driver'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(),
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void
    queueMicrotask(() => callback(null, '', ''))
    return {}
  }),
}))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-record-fixture-test-'))
  vi.mocked(spawn).mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

it.each(['codex', 'opencode', 'pi', 'claude', 'grok', 'hermes'] as const)(
  'records a real %s prompt transport instead of an empty turn',
  async (kind) => {
    const prompt = ` \n${'prompt 中文 &$ " '.repeat(900)}\nCurrent request \n`
    const session: AdapterSession = {
      sessionId: 'recorder',
      workspacePath: root,
      prompt,
      modelId: null,
      permissionMode: 'ask',
      resumeOf: null,
    }
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    let input = ''
    let promptPath = ''
    child.stdin.setEncoding('utf8')
    child.stdin.on('data', (chunk: string) => (input += chunk))
    const wire = '{"type":"result","result":"ok"}\n'
    vi.mocked(spawn).mockImplementation((_binary, args) => {
      const argv = args as string[]
      if (kind === 'grok') promptPath = argv[argv.indexOf('--prompt-file') + 1]!
      queueMicrotask(() => {
        child.stdout.write(wire)
        child.emit('close', 0)
      })
      return child as unknown as ReturnType<typeof spawn>
    })
    const path = join(root, 'record.jsonl')
    const result = await recordFixture(kind, 'agent.exe', session, path)
    expect(result).toMatchObject({ exitCode: 0, lineCount: 1, byteCount: Buffer.byteLength(wire) })
    expect(await readFile(path, 'utf8')).toBe(wire)
    const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
    if (kind === 'grok') {
      expect(input).toBe('')
      await expect(stat(promptPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } else if (kind === 'hermes') {
      expect(input).toBe('')
      expect(args).toContain(prompt)
    } else {
      expect(args.join(' ')).not.toContain('Current request')
      expect(
        kind === 'claude'
          ? (JSON.parse(input) as { message: { content: { text: string }[] } }).message.content[0]!
              .text
          : input,
      ).toBe(prompt)
    }
  },
)

it('keeps Grok prompt text after a process error until close', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  let resolvePath!: (path: string) => void
  const spawned = new Promise<string>((resolve) => {
    resolvePath = resolve
  })
  vi.mocked(spawn).mockImplementation((_binary, args) => {
    const argv = args as string[]
    resolvePath(argv[argv.indexOf('--prompt-file') + 1]!)
    return child as unknown as ReturnType<typeof spawn>
  })
  const recording = recordFixture(
    'grok',
    'agent.exe',
    {
      sessionId: 'recorder',
      workspacePath: root,
      prompt: 'keep until closed',
      modelId: null,
      permissionMode: 'ask',
      resumeOf: null,
    },
    join(root, 'error.jsonl'),
  )
  const path = await spawned
  child.emit('error', new Error('process error'))
  expect(await readFile(path, 'utf8')).toBe('keep until closed')
  child.emit('close', 1)
  await expect(recording).rejects.toThrow('process error')
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
