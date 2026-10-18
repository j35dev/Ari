import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AdapterSession } from '../driver'
import { spawnCli } from '../spawn-cli'
import { argvSafeText, buildClaudeArgs, buildUserFrame, ClaudeDriver } from './claude-driver'

describe('ClaudeDriver spawn', () => {
  it('passes session.runtimeEnv through the spawn seam', async () => {
    let seen: Record<string, string | undefined> | undefined
    const driver = new ClaudeDriver('claude', {
      spawn: (_binary, _args, options) => {
        seen = options.env
        throw new Error('stop')
      },
    })
    expect(() =>
      driver.create({
        sessionId: 's',
        workspacePath: 'D:\\proj',
        prompt: 'hi',
        modelId: null,
        permissionMode: 'ask',
        resumeOf: null,
        runtimeEnv: { CLAUDE_CONFIG_DIR: 'D:\\home\\.claude', PATH: 'D:\\bin' },
      }),
    ).toThrow('stop')
    expect(seen).toMatchObject({ CLAUDE_CONFIG_DIR: 'D:\\home\\.claude' })
  })
})

describe('buildClaudeArgs', () => {
  const base: AdapterSession = {
    sessionId: 'sess_1',
    workspacePath: 'D:\\proj',
    prompt: 'do the thing',
    modelId: null,
    permissionMode: 'ask',
    resumeOf: null,
  }

  it('uses bidirectional stream-json with stdio permission prompts and partial messages (no -p; prompt rides stdin)', () => {
    const args = buildClaudeArgs(base)
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--verbose')
    expect(args).toContain('--include-partial-messages')
    expect(args.indexOf('--input-format')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json')
    expect(args.indexOf('--permission-prompt-tool')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio')
    expect(args).not.toContain('-p')
  })

  it('appends host instructions to the system prompt on every spawn, resumed or not', () => {
    const note = 'You are running inside the Ari desktop app.'
    for (const session of [
      { ...base, instructions: note },
      { ...base, instructions: note, resumeOf: 'thread-1' },
    ]) {
      const args = buildClaudeArgs(session)
      expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(note)
    }
    expect(buildClaudeArgs(base)).not.toContain('--append-system-prompt')
    expect(new ClaudeDriver('claude').systemInstructions).toBe(true)
  })

  it('never puts a double quote or a percent sign into the system prompt argument', () => {
    // A session title reaches this text, and a `.cmd` shim re-parses the
    // argument with cmd.exe: an inner quote would hand the rest to the shell.
    const hostile =
      'You work for the session "Fix build & echo INJECTED> injected.txt & rem". Ask with "<question>".\nUse %PATH% freely.'
    const args = buildClaudeArgs({ ...base, instructions: hostile })
    const value = args[args.indexOf('--append-system-prompt') + 1] ?? ''
    expect(value).not.toMatch(/["%\r\n]/)
    expect(value).toContain("'Fix build & echo INJECTED> injected.txt & rem'")
    expect(argvSafeText('plain text')).toBe('plain text')
  })

  // The real thing: an npm-style shim that forwards `%*`, as a global
  // `claude.cmd` does. Unsanitized, this title ran `echo` and wrote the file.
  it.runIf(process.platform === 'win32')(
    'passes a hostile title through a real .cmd shim as one inert argument',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ari shim '))
      try {
        await writeFile(
          join(dir, 'print.cjs'),
          'process.stdout.write(JSON.stringify(process.argv.slice(2)))',
        )
        await writeFile(join(dir, 'claude.cmd'), '@echo off\r\nnode "%~dp0print.cjs" %*\r\n')
        const note = argvSafeText(
          'You work for "Fix build & echo INJECTED> injected.txt & rem". Ask with "<question>". %PATH%',
        )
        const child = spawnCli(join(dir, 'claude.cmd'), ['--append-system-prompt', note, '--x'], {
          cwd: dir,
        })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
        await new Promise((resolve) => child.on('close', resolve))
        expect(JSON.parse(out)).toEqual(['--append-system-prompt', note, '--x'])
        expect(existsSync(join(dir, 'injected.txt'))).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    20_000,
  )

  it('maps permission modes to claude flags', () => {
    expect(buildClaudeArgs({ ...base, permissionMode: 'ask' })).toContain('default')
    expect(buildClaudeArgs({ ...base, permissionMode: 'allow-edits' })).toContain('acceptEdits')
    expect(buildClaudeArgs({ ...base, permissionMode: 'full' })).toContain('bypassPermissions')
  })

  it('includes model and resume when provided', () => {
    const args = buildClaudeArgs({
      ...base,
      modelId: 'claude-sonnet-4-5',
      resumeOf: 'abc-session',
    })
    expect(args.indexOf('--model')).toBeGreaterThan(-1)
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-session')
  })

  it('omits model/resume when absent', () => {
    const args = buildClaudeArgs(base)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--resume')
  })
})

describe('buildUserFrame', () => {
  it('sends text-only prompts as a single text block', () => {
    expect(buildUserFrame('do the thing')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    })
  })

  it('sends staged images as base64 image blocks after the text', () => {
    expect(
      buildUserFrame('look', [{ dataBase64: 'aGk=', mimeType: 'image/png' }]),
    ).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      },
    })
  })
})
