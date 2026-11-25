import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AdapterSession, Driver } from './driver'
import { AcpConnection } from './acp/connection'
import { AppServerConnection } from './codex/appserver-connection'
import { ClaudeCliDriver } from './claude/cli-driver'
import { runCaptured } from './off-thread'
import { CodexDriver } from './codex/codex-driver'
import { GrokDriver } from './grok/grok-driver'
import { HermesDriver } from './hermes/hermes-driver'
import { OpencodeDriver } from './opencode/opencode-driver'
import { PiDriver } from './pi/pi-driver'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-cli-interrupt-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * An npm-style `.cmd` shim: cmd.exe runs node, which records its pid and then
 * ignores stdin and signals to cmd.exe alike — only a tree kill ends it.
 */
async function shim(name: string): Promise<{ path: string; pid: () => Promise<number> }> {
  const pidFile = join(dir, `${name}.pid`)
  const script = join(dir, `${name}.js`)
  await writeFile(
    script,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\n`,
  )
  const path = join(dir, `${name}.cmd`)
  await writeFile(path, `@"${process.execPath}" "${script}" %*\r\n`)
  return {
    path,
    pid: () => vi.waitFor(async () => Number(await readFile(pidFile, 'utf8')), { timeout: 15_000 }),
  }
}

describe.runIf(process.platform === 'win32')('CLIs behind an npm .cmd shim', () => {
  it.each([
    ['opencode', (bin: string): Driver => new OpencodeDriver(bin)],
    ['pi', (bin: string): Driver => new PiDriver(bin)],
    ['grok', (bin: string): Driver => new GrokDriver(bin)],
    ['hermes', (bin: string): Driver => new HermesDriver(bin)],
    ['codex', (bin: string): Driver => new CodexDriver(bin, { probe: null })],
    // Ignores the interrupt frame, so the kill fallback has to end it.
    ['claude', (bin: string): Driver => new ClaudeCliDriver(bin, { pool: null })],
  ])(
    'Stop ends the real %s process, not just cmd.exe',
    async (name, driver) => {
      const cli = await shim(name)
      const session: AdapterSession = {
        sessionId: name,
        workspacePath: dir,
        prompt: 'hello',
        modelId: null,
        permissionMode: 'ask',
        resumeOf: null,
      }
      const adapter = await driver(cli.path).create(session)
      const drained = (async () => {
        for await (const _event of adapter.start()) void _event
      })()
      const pid = await cli.pid()
      expect(alive(pid)).toBe(true)

      adapter.interrupt()
      await drained
      expect(alive(pid)).toBe(false)
      await adapter.dispose()
    },
    30_000,
  )

  it('a failed ACP handshake ends the whole adapter tree', async () => {
    const cli = await shim('acp')
    await expect(
      AcpConnection.connect({
        launch: { label: 'shim-agent', command: cli.path, args: [] },
        cwd: dir,
        initializeTimeoutMs: 1_000,
      }),
    ).rejects.toThrow()
    expect(alive(await cli.pid())).toBe(false)
  }, 30_000)

  it('a timed-out off-thread command ends the whole tree', async () => {
    const cli = await shim('version-probe')
    const run = runCaptured(cli.path, ['--version'], { timeoutMs: 1_500 })
    const pid = await cli.pid()
    expect(await run).toEqual({ code: null, stdout: '' })
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5_000 })
  }, 30_000)

  it('killing the Codex app-server connection ends the whole tree', async () => {
    const cli = await shim('codex-app-server')
    const connection = AppServerConnection.start({ binaryPath: cli.path, cwd: dir })
    const pid = await cli.pid()
    expect(alive(pid)).toBe(true)
    await connection.kill()
    expect(alive(pid)).toBe(false)
  }, 30_000)
})
