import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildCmdSpawnArgs,
  buildPowershellSpawnArgs,
  buildShellSpawnArgs,
  needsWindowsShell,
  spawnCli,
  writeCliPrompt,
  argsWithWindowsHandoffBudget,
} from './spawn-cli'
import type { AdapterSession } from './driver'
import { buildCodexArgs } from './codex/codex-driver'
import { buildOpencodeArgs } from './opencode/opencode-driver'
import { buildPiArgs } from './pi/pi-driver'
import { buildHermesArgs } from './hermes/hermes-driver'

describe('Windows handoff budget', () => {
  const realPlatform = process.platform
  let scratch: string
  const shimSource = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe" "%~dp0\\node_modules\\agent\\cli.js" %*
) ELSE (
  node "%~dp0\\node_modules\\agent\\cli.js" %*
)`
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ari-handoff-shim-'))
    await mkdir(join(scratch, 'node_modules', '.bin'), { recursive: true })
    await mkdir(join(scratch, 'npm'))
    await Promise.all(
      ['codex', 'opencode', 'pi', 'grok', 'hermes', 'agent'].map((kind) =>
        writeFile(join(scratch, 'node_modules', '.bin', `${kind}.cmd`), shimSource),
      ),
    )
    await writeFile(join(scratch, 'npm', 'agent.cmd'), shimSource)
    await writeFile(join(scratch, 'npm', 'plain.cmd'), '@echo %*')
  })
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const handoff =
    '[Conversation so far]\n\n' + 'older & % report '.repeat(800) + '\nAria: latest work'
  const session: AdapterSession = {
    sessionId: 'aria',
    workspacePath: '/w',
    prompt: `Preamble\n\n${handoff}\n\n[Ari now]\n\nCurrent request`,
    handoff,
    modelId: 'chosen',
    permissionMode: 'ask',
    resumeOf: null,
  }

  it.each([['hermes', buildHermesArgs]] as const)(
    'fits %s fallback argv after Windows escaping and keeps the newest history',
    (kind, buildArgs) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const binary = join(scratch, 'node_modules', '.bin', `${kind}.cmd`)
      const args = argsWithWindowsHandoffBudget(binary, session, buildArgs)
      const wrapped = buildCmdSpawnArgs(binary, args)
      expect(wrapped.file.length + 1 + wrapped.args.join(' ').length).toBeLessThanOrEqual(
        8_191 - 512,
      )
      const prompt = args.find((arg) => arg.includes('Current request'))!
      expect(prompt).toContain('Preamble')
      expect(prompt).toContain('[Conversation so far]')
      expect(prompt).toContain('Aria: latest work')
      expect(prompt).toContain('[Ari now]\n\nCurrent request')
      expect(prompt.length).toBeLessThan(session.prompt.length)
      expect(session.prompt).toContain(handoff)
    },
  )

  it('preserves replacement-pattern dollars literally when trimming history', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const literal = ['$&', "$'", '$`', '$$'].join(' ')
    const carried = `[Conversation so far]\n\n${'older '.repeat(2_000)}${literal}`
    const args = argsWithWindowsHandoffBudget(
      'agent.cmd',
      { ...session, handoff: carried, prompt: `Preamble\n\n${carried}\n\nCurrent request` },
      buildHermesArgs,
    )
    const prompt = args[1]!
    expect(prompt).toContain(literal)
    expect(prompt).toMatch(/^Preamble\n\n\[Conversation so far\]/)
    expect(prompt.endsWith(`${literal}\n\nCurrent request`)).toBe(true)
    expect(prompt.match(/Preamble/g)).toHaveLength(1)
    expect(prompt.match(/Current request/g)).toHaveLength(1)
  })

  it.each(['local', 'global'])(
    'leaves room for a %s npm shim prefix even when the outer command alone fits',
    (layout) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const binary =
        layout === 'local'
          ? join(scratch, 'node_modules', '.bin', 'agent.cmd')
          : join(scratch, 'npm', 'agent.cmd')
      const carried = `[Conversation so far]\n\n${'x'.repeat(7_650)}`
      const bounded = { ...session, handoff: carried, prompt: carried }
      const original = buildCmdSpawnArgs(binary, buildHermesArgs(bounded))
      const originalLength = original.file.length + 1 + original.args.join(' ').length
      expect(originalLength).toBeLessThanOrEqual(8_191)
      expect(originalLength).toBeGreaterThan(8_191 - 512)
      const wrapped = buildCmdSpawnArgs(
        binary,
        argsWithWindowsHandoffBudget(binary, bounded, buildHermesArgs),
      )
      expect(wrapped.file.length + 1 + wrapped.args.join(' ').length).toBeLessThanOrEqual(
        8_191 - 512,
      )
    },
  )

  it.each(['agent.cmd', 'agent.bat'])(
    'preserves history that fits %s without a shim margin',
    (binary) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const carried = `[Conversation so far]\n\n${'x'.repeat(7_650)}`
      const bounded = { ...session, handoff: carried, prompt: carried }
      const wrapped = buildCmdSpawnArgs(binary, buildHermesArgs(bounded))
      const length = wrapped.file.length + 1 + wrapped.args.join(' ').length
      expect(length).toBeGreaterThan(8_191 - 512)
      expect(length).toBeLessThanOrEqual(8_191)
      expect(argsWithWindowsHandoffBudget(binary, bounded, buildHermesArgs)).toEqual(
        buildHermesArgs(bounded),
      )
    },
  )

  it('does not reserve npm margin for an ordinary cmd script in a global npm folder', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const binary = join(scratch, 'npm', 'plain.cmd')
    const carried = `[Conversation so far]\n\n${'x'.repeat(7_650)}`
    const bounded = { ...session, handoff: carried, prompt: carried }
    const original = buildHermesArgs(bounded)
    const wrapped = buildCmdSpawnArgs(binary, original)
    const length = wrapped.file.length + 1 + wrapped.args.join(' ').length
    expect(length).toBeGreaterThan(8_191 - 512)
    expect(length).toBeLessThanOrEqual(8_191)
    expect(argsWithWindowsHandoffBudget(binary, bounded, buildHermesArgs)).toEqual(original)
  })

  it.each([
    { layout: 'local', length: 7_678 },
    { layout: 'global', length: 7_678 },
    { layout: 'local', length: 7_700 },
    { layout: 'global', length: 7_700 },
  ])(
    'honours the $layout shim margin with no history room (baseline: $length)',
    ({ layout, length }) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const binary =
        layout === 'local'
          ? join(scratch, 'node_modules', '.bin', 'agent.cmd')
          : join(scratch, 'npm', 'agent.cmd')
      const empty = buildCmdSpawnArgs(binary, buildHermesArgs({ ...session, prompt: '\n\n' }))
      const overhead = empty.file.length + 1 + empty.args.join(' ').length
      const carried = '[Conversation so far]\n\nAria: Latest work'
      const bounded = {
        ...session,
        handoff: carried,
        prompt: `${'x'.repeat(length - overhead)}\n\n${carried}`,
      }
      const original = buildHermesArgs(bounded)
      const wrapped = buildCmdSpawnArgs(binary, original)
      expect(wrapped.file.length + 1 + wrapped.args.join(' ').length).toBeLessThanOrEqual(8_191)
      const args = argsWithWindowsHandoffBudget(binary, bounded, buildHermesArgs)
      expect(args[1]).not.toContain('[Conversation so far]')
      expect(args).not.toEqual(original)
      const reduced = buildCmdSpawnArgs(binary, args)
      const reducedLength = reduced.file.length + 1 + reduced.args.join(' ').length
      if (length <= 8_191 - 512) expect(reducedLength).toBeLessThanOrEqual(8_191 - 512)
      else expect(reducedLength).toBeLessThanOrEqual(length)
    },
  )

  it('keeps the full history for direct executables, PowerShell and non-Windows argv', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    for (const binary of ['agent.exe', 'agent.ps1'])
      expect(argsWithWindowsHandoffBudget(binary, session, buildHermesArgs)).toEqual(
        buildHermesArgs(session),
      )
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(argsWithWindowsHandoffBudget('agent.cmd', session, buildHermesArgs)).toEqual(
      buildHermesArgs(session),
    )
  })
})

describe('buildCmdSpawnArgs', () => {
  it('wraps the command line in an escaped cmd.exe invocation', () => {
    const wrapped = buildCmdSpawnArgs('C:\\Users\\u\\npm\\claude.cmd', [
      '-p',
      'fix the && bug > log | pipe',
    ])
    expect(wrapped.file).toBe(process.env['ComSpec'] ?? 'cmd.exe')
    expect(wrapped.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // The whole shell command is one verbatim argument.
    expect(wrapped.args).toHaveLength(4)
    const shellCommand = wrapped.args[3]!
    expect(shellCommand.startsWith('"')).toBe(true)
    expect(shellCommand.endsWith('"')).toBe(true)
    expect(wrapped.windowsVerbatimArguments).toBe(true)
  })

  it('produces the exact expected command line for a known input', () => {
    const wrapped = buildCmdSpawnArgs('C:\\bin\\x.cmd', ['-p', 'fix && run'])
    expect(wrapped.args[3]).toBe('"C:\\bin\\x.cmd ^"-p^" ^"fix^ ^&^&^ run^""')
  })

  it('caret-escapes every cmd metacharacter inside arguments', () => {
    const wrapped = buildCmdSpawnArgs('C:\\bin\\x.cmd', ['a & b | c < d > e %f% ^g'])
    const shellCommand = wrapped.args[3]!
    expect(shellCommand).toContain('^&')
    expect(shellCommand).toContain('^|')
    expect(shellCommand).toContain('^<')
    expect(shellCommand).toContain('^>')
    expect(shellCommand).toContain('^%f^%')
    // A literal caret doubles.
    expect(shellCommand).toContain('^^g')
  })

  it('keeps embedded double quotes literal for both parsers', () => {
    const wrapped = buildCmdSpawnArgs('C:\\bin\\x.cmd', ['say "hello" now'])
    const shellCommand = wrapped.args[3]
    // Embedded quotes become \" then the quote itself is caret-escaped by the
    // metachar pass: \^"
    expect(shellCommand).toContain('\\^"')
  })

  it('doubles trailing backslashes so they cannot escape the closing quote', () => {
    const wrapped = buildCmdSpawnArgs('C:\\bin\\x.cmd', ['path\\'])
    const shellCommand = wrapped.args[3]
    expect(shellCommand).toContain('path\\\\^"')
  })

  it('leaves interior backslashes alone', () => {
    const wrapped = buildCmdSpawnArgs('C:\\bin\\x.cmd', ['back\\slash'])
    expect(wrapped.args[3]).toBe('"C:\\bin\\x.cmd ^"back\\slash^""')
  })

  it('escapes spaces in quoted args so cmd cannot split them', () => {
    const wrapped = buildCmdSpawnArgs('C:\\Program Files\\tool\\cli.cmd', ['-p', 'two words'])
    const shellCommand = wrapped.args[3]
    // The binary path's space must be caret-escaped (command is not quoted).
    expect(shellCommand).toContain('Program^ Files')
    // Argument spaces are escaped inside quotes too.
    expect(shellCommand).toContain('two^ words')
  })

  it('double-escapes node_modules/.bin cmd shims only', () => {
    const binShim = 'C:\\proj\\node_modules\\.bin\\claude.cmd'
    const plain = 'C:\\npm-prefix\\claude.cmd'
    const shimWrapped = buildCmdSpawnArgs(binShim, ['a & b'])
    const plainWrapped = buildCmdSpawnArgs(plain, ['a & b'])
    // .bin shims re-parse through another cmd layer → carets are doubled.
    expect(shimWrapped.args[3]).toContain('^^&')
    expect(plainWrapped.args[3]).not.toContain('^^&')
    expect(plainWrapped.args[3]).toContain('^&')
  })
})

describe('needsWindowsShell', () => {
  const realPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  })

  function withPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform })
  }

  it('is false off Windows', () => {
    withPlatform('linux')
    expect(needsWindowsShell('/usr/local/bin/claude.sh')).toBe(false)
    expect(needsWindowsShell('C:\\bin\\claude.cmd')).toBe(false)
  })

  it('on Windows wraps anything that is not .com/.exe', () => {
    withPlatform('win32')
    expect(needsWindowsShell('C:\\bin\\claude.cmd')).toBe(true)
    expect(needsWindowsShell('C:\\bin\\claude.bat')).toBe(true)
    expect(needsWindowsShell('C:\\bin\\claude.ps1')).toBe(true)
    expect(needsWindowsShell('C:\\bin\\claude')).toBe(true)
    expect(needsWindowsShell('C:\\bin\\claude.exe')).toBe(false)
  })
})

describe('buildPowershellSpawnArgs', () => {
  it('invokes powershell.exe -File with argv passed through literally', () => {
    const wrapped = buildPowershellSpawnArgs('C:\\Users\\u\\.pi\\agent\\bin\\pi.ps1', [
      '--mode',
      'json',
      '-p',
      'fix the && bug > log | pipe',
    ])
    expect(wrapped.file).toBe('powershell.exe')
    expect(wrapped.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
    ])
    expect(wrapped.args[5]).toBe('C:\\Users\\u\\.pi\\agent\\bin\\pi.ps1')
    // Prompt text rides along unescaped: -File never re-parses metacharacters.
    expect(wrapped.args.slice(6)).toEqual(['--mode', 'json', '-p', 'fix the && bug > log | pipe'])
  })

  it('splats literal arguments when -File would reject the standalone stdin marker', () => {
    const path = "C:\\owner's project\\agent.ps1"
    const args = ['exec', 'resume', 'thread', '-']
    const wrapped = buildPowershellSpawnArgs(path, args)
    expect(wrapped.args[4]).toBe('-EncodedCommand')
    const command = Buffer.from(wrapped.args[5]!, 'base64').toString('utf16le')
    expect(command).toContain("@('exec', 'resume', 'thread', '-')")
    expect(command).toContain("& 'C:\\owner''s project\\agent.ps1' @cliArgs")
  })
})

describe('buildShellSpawnArgs', () => {
  it('routes .ps1 through powershell and .cmd through cmd.exe', () => {
    const ps1 = buildShellSpawnArgs('C:\\bin\\pi.ps1', ['--version'])
    expect(ps1.file).toBe('powershell.exe')
    expect(ps1.args).toContain('-File')
    // powershell.exe needs Node's own quoting; only the cmd wrapper quotes itself.
    expect(ps1.windowsVerbatimArguments).toBe(false)

    const cmd = buildShellSpawnArgs('C:\\bin\\pi.cmd', ['--version'])
    expect(cmd.file).toBe(process.env['ComSpec'] ?? 'cmd.exe')
    expect(cmd.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(cmd.windowsVerbatimArguments).toBe(true)
  })
})

describe.runIf(process.platform === 'win32')('spawnCli with a real .ps1', () => {
  it('delivers a path with spaces and a multi-word prompt intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari ps1 '))
    const script = join(dir, 'echo args.ps1')
    await writeFile(script, '$args | ForEach-Object { Write-Output $_ }', 'utf8')
    const child = spawnCli(script, ['-p', 'fix the && bug $env:USERNAME > log'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(0)
    expect(stdout.trim().split(/\r?\n/)).toEqual(['-p', 'fix the && bug $env:USERNAME > log'])
  }, 30_000)

  it('passes live JSON frames to a PowerShell-only script before stdin closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari ps1 '))
    try {
      const script = join(dir, 'server.ps1')
      await writeFile(
        script,
        '[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())',
      )
      const child = spawnCli(script, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const frame = '{"prompt":"中文"}\n'
      let output = ''
      const first = new Promise<void>((resolve, reject) => {
        child.on('error', reject)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          output += chunk
          if (output === frame) resolve()
        })
      })
      const closed = new Promise((resolve) => child.once('close', resolve))
      child.stdin.write(frame)
      await first
      expect(child.stdin.writableEnded).toBe(false)
      child.stdin.end()
      expect(await closed).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }, 30_000)
})

describe.runIf(process.platform === 'win32')('long prompts through real Windows shims', () => {
  it.each([
    ['codex', buildCodexArgs],
    ['opencode', buildOpencodeArgs],
    ['pi', buildPiArgs],
  ] as const)(
    '%s preserves prompt bytes through .cmd and .ps1 stdin',
    async (kind, buildArgs) => {
      const dir = await mkdtemp(join(tmpdir(), 'ari stdin '))
      const prompt = ` \n${'Preamble & %PATH% "$&" 中文 🙂\r\n'.repeat(1_000)}\nCurrent request \n`
      const session: AdapterSession = {
        sessionId: 's',
        workspacePath: dir,
        prompt,
        modelId: null,
        permissionMode: 'ask',
        resumeOf: 'old-thread',
      }
      try {
        await writeFile(join(dir, 'echo.cjs'), 'process.stdin.pipe(process.stdout)')
        await mkdir(join(dir, 'cmd'))
        await mkdir(join(dir, 'ps1'))
        await writeFile(
          join(dir, 'cmd', `${kind}.cmd`),
          '@echo off\r\nnode "%~dp0..\\echo.cjs" %*\r\n',
        )
        await writeFile(
          join(dir, 'ps1', `${kind}.ps1`),
          '[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())',
        )
        for (const extension of ['cmd', 'ps1']) {
          const child = spawnCli(join(dir, extension, `${kind}.${extension}`), buildArgs(session), {
            cwd: dir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
          let output = ''
          let errors = ''
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (chunk: string) => (output += chunk))
          child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString('utf8')))
          const closed = new Promise<number | null>((resolve, reject) => {
            child.once('close', resolve)
            child.once('error', reject)
          })
          writeCliPrompt(child.stdin, prompt)
          expect(await closed, errors).toBe(0)
          expect(output).toBe(prompt)
        }
      } finally {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    },
    30_000,
  )
})
