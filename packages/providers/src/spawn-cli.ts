import { spawn } from 'node:child_process'
import type { SpawnOptions, ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Windows CLI spawn support.
 *
 * Node refuses to spawn `.cmd`/`.bat` files directly without a shell (EINVAL,
 * a deliberate hardening), and `shell: true` would concatenate raw user text
 * into cmd.exe. Instead we wrap the invocation in cmd.exe ourselves with
 * explicit escaping — the algorithm is ported verbatim from cross-spawn v7
 * (MIT, moxystudio/node-cross-spawn), which is built on https://qntm.org/cmd.
 *
 * PowerShell scripts (`.ps1`, e.g. the Pi agent's Windows installer layout)
 * cannot run through cmd.exe at all, so they are spawned via
 * `powershell.exe -File` instead — argv stays literal, never re-parsed.
 */

// See http://www.robvanderwoude.com/escapechars.php
const metaCharsRegExp = /([()\][%!^"`<>&|;, *?])/g

/** npm-style cmd shims re-parse arguments through a second cmd layer. */
const isCmdShimRegExp = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i

function escapeCommand(command: string): string {
  return command.replace(metaCharsRegExp, '^$1')
}

function escapeArgument(arg: string, doubleEscapeMetaChars: boolean): string {
  arg = `${arg}`

  // Sequence of backslashes followed by a double quote:
  // double up all the backslashes and escape the double quote.
  arg = arg.replace(/(\\*)"/g, '$1$1\\"')

  // Sequence of backslashes followed by the end of the string (which will
  // become a double quote later): double up all the backslashes.
  arg = arg.replace(/(\\*)$/, '$1$1')

  // Quote the whole thing.
  arg = `"${arg}"`

  // Escape meta chars.
  arg = arg.replace(metaCharsRegExp, '^$1')

  // When the target is a node_modules/.bin cmd shim, the metachar escaping is
  // interpreted once more by the shim's own cmd layer — escape twice.
  if (doubleEscapeMetaChars) {
    arg = arg.replace(metaCharsRegExp, '^$1')
  }

  return arg
}

/**
 * True when the binary is a PowerShell script: cmd.exe cannot execute it, so
 * it must go through powershell.exe -File rather than the cmd wrapper.
 */
export function isPowershellScript(binaryPath: string): boolean {
  return /\.ps1$/i.test(binaryPath)
}

/**
 * True when spawning this binary needs the cmd.exe wrapper on Windows
 * (anything that is not a native .com/.exe executable).
 */
export function needsWindowsShell(binaryPath: string): boolean {
  return process.platform === 'win32' && !/\.(?:com|exe)$/i.test(binaryPath)
}

/**
 * Builds the argv for spawning a `.ps1` script via powershell.exe:
 * `-File` passes every later arg through literally, so prompt text with
 * cmd metacharacters (`&`, `|`, `>`) is never re-parsed as a command line.
 */
export function buildPowershellSpawnArgs(
  binaryPath: string,
  args: string[],
): { file: string; args: string[] } {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', binaryPath, ...args],
  }
}

/**
 * Windows shell dispatch: `.ps1` goes through powershell.exe, everything
 * else needing a shell through the escaped cmd.exe wrapper. Callers that
 * branch on {@link needsWindowsShell} should use this instead of calling
 * {@link buildCmdSpawnArgs} directly, or a detected `.ps1` CLI will be
 * reported as installed and then fail on use.
 */
export function buildShellSpawnArgs(
  binaryPath: string,
  args: string[],
): { file: string; args: string[]; windowsVerbatimArguments: true } {
  if (isPowershellScript(binaryPath)) {
    return { ...buildPowershellSpawnArgs(binaryPath, args), windowsVerbatimArguments: true }
  }
  return buildCmdSpawnArgs(binaryPath, args)
}

/**
 * Builds the argv for spawning via cmd.exe: ['/d', '/s', '/c', '"<escaped>"'].
 * The caller must pass `windowsVerbatimArguments: true`.
 */
export function buildCmdSpawnArgs(
  binaryPath: string,
  args: string[],
): { file: string; args: string[]; windowsVerbatimArguments: true } {
  const doubleEscapeMetaChars = isCmdShimRegExp.test(binaryPath)
  const shellCommand = [escapeCommand(binaryPath), ...args.map((a) => escapeArgument(a, doubleEscapeMetaChars))].join(
    ' ',
  )
  return {
    file: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * Spawns an external CLI safely on every platform: direct argv elsewhere,
 * a fully-escaped cmd.exe wrapper for .cmd/.bat scripts on Windows, and
 * powershell.exe -File for .ps1 scripts — so arbitrary prompt text can
 * never be parsed as a command line.
 *
 * Returns the non-null-stream shape every driver uses (callers pass pipe
 * stdio); the wrapped paths are cast to match since they spawn the same way.
 */
export function spawnCli(
  binaryPath: string,
  args: string[],
  options: SpawnOptions,
): ChildProcessWithoutNullStreams {
  if (!needsWindowsShell(binaryPath)) {
    // Callers always pass pipe stdio; the non-null-stream overload applies.
    return spawn(binaryPath, args, options) as ChildProcessWithoutNullStreams
  }
  const wrapped = buildShellSpawnArgs(binaryPath, args)
  return spawn(wrapped.file, wrapped.args, {
    ...options,
    windowsVerbatimArguments: true,
  }) as ChildProcessWithoutNullStreams
}
