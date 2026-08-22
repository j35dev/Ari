import { afterEach, describe, expect, it } from 'vitest'
import { buildCmdSpawnArgs, needsWindowsShell } from './spawn-cli'

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
    expect(needsWindowsShell('C:\\bin\\claude')).toBe(true)
    expect(needsWindowsShell('C:\\bin\\claude.exe')).toBe(false)
  })
})
