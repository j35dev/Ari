import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterSession } from './driver'
import { promptWithAttachments, missingImagesNote } from './attachments'
import { ClaudeDriver } from './claude/claude-driver'
import { CodexDriver } from './codex/codex-driver'
import { GrokDriver } from './grok/grok-driver'
import { OpencodeDriver } from './opencode/opencode-driver'
import { PiDriver } from './pi/pi-driver'
import { HermesDriver } from './hermes/hermes-driver'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: vi.fn(),
  execFile: vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void
    queueMicrotask(() => callback(null, '', ''))
    return {}
  }),
}))

const realPlatform = process.platform
let scratchDir: string
let binDir: string
beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'ari-prompt-spawn-'))
  binDir = join(scratchDir, 'node_modules', '.bin')
  await mkdir(binDir, { recursive: true })
})
afterAll(async () => {
  await rm(scratchDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
})
const handoff = `[Conversation so far]\n\n${'older & % report '.repeat(1_000)}\nAria: latest work`
const session: AdapterSession = {
  sessionId: 'aria',
  workspacePath: 'C:\\project',
  prompt: ` \nPreamble ${'baseline '.repeat(1_200)}\n\n${handoff}\n\n[Ari now]\n\nCurrent request 中文 🙂 "$&" \n`,
  handoff,
  modelId: 'chosen',
  permissionMode: 'ask',
  resumeOf: null,
  runtimeEnv: { PATH: 'C:\\bin' },
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: 0,
    kill: vi.fn(() => true),
  })
  let input = ''
  child.stdin.setEncoding('utf8')
  child.stdin.on('data', (chunk: string) => (input += chunk))
  return { child, input: () => input }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.mocked(spawn).mockReset()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

function spawner(fixture: ReturnType<typeof fakeChild>) {
  vi.mocked(spawn).mockReturnValue(fixture.child as unknown as ReturnType<typeof spawn>)
}

function wrappedArgs(): string[] {
  return vi.mocked(spawn).mock.calls[0]![1] as string[]
}

describe.each(['cmd', 'ps1', 'exe'])(
  'CLI prompt transport through Windows .%s spawns',
  (extension) => {
    it.each([
      ['codex', (binary: string) => new CodexDriver(binary, { probe: null })],
      ['opencode', (binary: string) => new OpencodeDriver(binary)],
      ['pi', (binary: string) => new PiDriver(binary)],
      ['claude', (binary: string) => new ClaudeDriver(binary)],
    ] as const)(
      '%s delivers all prompt text on stdin, including resumed turns and attachments',
      async (kind, driver) => {
        for (const resumeOf of [null, 'old-thread']) {
          const fixture = fakeChild()
          spawner(fixture)
          const attachments = [
            { id: 'image', name: 'diagram.png', mimeType: 'image/png', path: null },
          ]
          const turn = { ...session, resumeOf, attachments }
          const adapter = await driver(join(binDir, `${kind}.${extension}`)).create(turn)
          const args = wrappedArgs()
          expect(args.join(' ').length).toBeLessThan(8_191 - 512)
          expect(args.join(' ')).not.toContain('Current request')
          expect(args.join(' ')).not.toContain('[Conversation so far]')
          expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({
            stdio: ['pipe', 'pipe', 'pipe'],
            env: session.runtimeEnv,
          })
          const input = fixture.input()
          const delivered =
            kind === 'claude'
              ? (JSON.parse(input) as { message: { content: { text: string }[] } }).message
                  .content[0]!.text
              : input
          expect(delivered).toBe(
            kind === 'claude'
              ? turn.prompt + missingImagesNote(attachments)
              : promptWithAttachments(turn),
          )
          expect(fixture.child.stdin.writableEnded).toBe(kind !== 'claude')
          await adapter.dispose()
          vi.mocked(spawn).mockClear()
        }
      },
    )

    it('grok sends the full prompt in a UTF-8 file and removes it after exit', async () => {
      const fixture = fakeChild()
      spawner(fixture)
      const adapter = await new GrokDriver(`C:\\node_modules\\.bin\\grok.${extension}`).create(
        session,
      )
      const args = wrappedArgs()
      expect(args.join(' ').length).toBeLessThan(8_191 - 512)
      expect(args.join(' ')).not.toContain('Current request')
      const plain = args.join(' ').replace(/\^/g, '')
      const path = args.includes('--prompt-file')
        ? args[args.indexOf('--prompt-file') + 1]!
        : plain.match(/"([^"]*ari-grok-prompt-[^"]+[\\/]prompt\.txt)"/)![1]!
      expect(await readFile(path, 'utf8')).toBe(session.prompt)
      expect(fixture.input()).toBe('')
      fixture.child.emit('error', new Error('transient process error'))
      expect(await readFile(path, 'utf8')).toBe(session.prompt)
      fixture.child.emit('close', 0)
      await adapter.dispose()
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  },
)

it('Hermes keeps the argv-only handoff budget without altering the current request', async () => {
  const fixture = fakeChild()
  spawner(fixture)
  // Budgeting history is possible when the baseline itself fits cmd.exe.
  const turn = { ...session, prompt: `Preamble\n\n${handoff}\n\n[Ari now]\n\nCurrent request` }
  const adapter = await new HermesDriver('C:\\node_modules\\.bin\\hermes.cmd').create(turn)
  const args = wrappedArgs().join(' ')
  expect(args.length).toBeLessThan(8_191)
  expect(args).toContain('Current')
  expect(args).toContain('latest')
  expect(fixture.input()).toBe('')
  expect(session.prompt).toContain(handoff)
  await adapter.dispose()
})

it('grok removes its prompt file when spawning fails', async () => {
  vi.mocked(spawn).mockImplementation(() => {
    throw new Error('spawn failed')
  })
  await expect(new GrokDriver('C:\\grok.exe').create(session)).rejects.toThrow('spawn failed')
  const args = wrappedArgs()
  const path = args[args.indexOf('--prompt-file') + 1]!
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
