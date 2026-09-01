import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import * as path from 'node:path'
import { createLogger } from '@ari/shared/logger'
import { needsWindowsShell, buildCmdSpawnArgs } from '@ari/providers/spawn-cli'

const log = createLogger('ari-core:rg')

/** Match cap shared with the JS fallback walk in tools.ts. */
export const RG_MAX_MATCHES = 100
/** Stdout byte cap; rg is killed once exceeded. */
export const RG_MAX_BUFFER = 64 * 1024
/** Wall-clock budget for one rg invocation. */
export const RG_TIMEOUT_MS = 10_000

let cached: Promise<string | null> | null = null

/**
 * Resolves the ripgrep binary from PATH (`rg.exe` / `rg`), memoized for the
 * process lifetime. Returns null when no executable copy is found.
 */
export function resolveRipgrep(): Promise<string | null> {
  cached ??= Promise.resolve(scanPath())
  return cached
}

/** Clears the memoized PATH scan (test hook). */
export function resetRipgrepCache(): void {
  cached = null
}

function scanPath(): string | null {
  const dirs = (process.env['PATH'] ?? process.env['Path'] ?? '').split(path.delimiter).filter(Boolean)
  const candidates = process.platform === 'win32' ? ['rg.exe', 'rg'] : ['rg']
  for (const dir of dirs) {
    for (const name of candidates) {
      const full = path.join(dir, name)
      try {
        accessSync(full, constants.X_OK)
        return full
      } catch {
        // not usable — keep scanning
      }
    }
  }
  return null
}

export interface RipgrepOptions {
  timeoutMs?: number
  maxMatches?: number
  /** Glob file filter passed as `--glob`. */
  glob?: string
  ignoreCase?: boolean
  /** `--fixed-strings` instead of regex matching. */
  literal?: boolean
  /** When set, match paths are rewritten relative to this root. */
  relativeTo?: string
}

function parseMatchLine(line: string, relativeTo?: string): string | null {
  // `--no-heading --line-number` emits `path:line:text`; paths containing
  // colons degrade exactly like the JS fallback's `relative:line:text`.
  const match = /^(.+):(\d+):(.*)$/.exec(line)
  if (!match || match[1] === undefined || match[2] === undefined) return null
  const text = (match[3] ?? '').trim().slice(0, 240)
  if (relativeTo === undefined) {
    return `${match[1]}:${match[2]}:${text}`
  }
  const rel = path.relative(relativeTo, match[1]).split(path.sep).join('/')
  return `${rel.startsWith('..') ? match[1] : rel}:${match[2]}:${text}`
}

/**
 * Runs ripgrep for a pattern (literal by default via options) under `cwd`
 * and formats matches as `path:line:text`, capped like the JS fallback.
 * Exit 0/1 resolve normally (1 = no matches); anything else rejects so
 * callers can fall back.
 */
export function searchWithRipgrep(
  rgPath: string,
  pattern: string,
  cwd: string,
  options: RipgrepOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? RG_TIMEOUT_MS
  const maxMatches = options.maxMatches ?? RG_MAX_MATCHES
  return new Promise((resolve, reject) => {
    // Same Windows rules as every other CLI spawn: direct argv for native
    // executables, fully-escaped cmd.exe wrapper otherwise, never shell:true
    // with raw text.
    let file = rgPath
    let argv = [
      '--line-number',
      '--no-heading',
      '--no-messages',
      ...(options.literal === true ? ['--fixed-strings'] : []),
      ...(options.ignoreCase === true ? ['--ignore-case'] : []),
      ...(options.glob !== undefined && options.glob.length > 0
        ? ['--glob', options.glob]
        : []),
      '-e',
      pattern,
      '.',
    ]
    if (needsWindowsShell(rgPath)) {
      const wrapped = buildCmdSpawnArgs(rgPath, argv.slice())
      file = wrapped.file
      argv = wrapped.args
    }
    const child = spawn(file, argv, {
      cwd,
      windowsHide: true,
      ...(needsWindowsShell(rgPath) ? { windowsVerbatimArguments: true as const } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: string[] = []
    let buffered = 0
    let settled = false
    let stdoutTail = ''

    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (err !== null) {
        reject(err)
        return
      }
      resolve(out.length === 0 ? '(no matches)' : out.join('\n'))
    }

    const timer = setTimeout(() => finish(new Error(`ripgrep timed out after ${timeoutMs}ms`)), timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.length
      stdoutTail += chunk.toString('utf8')
      while (out.length < maxMatches) {
        const newlineAt = stdoutTail.indexOf('\n')
        if (newlineAt === -1) break
        // Strip CRLF's trailing \r — `.`/`$` in parseMatchLine never match it.
        const line = stdoutTail.slice(0, newlineAt).replace(/\r$/, '')
        stdoutTail = stdoutTail.slice(newlineAt + 1)
        const formatted = parseMatchLine(line, options.relativeTo)
        if (formatted !== null) out.push(formatted)
        if (out.length >= maxMatches || buffered >= RG_MAX_BUFFER) {
          finish(null)
          return
        }
      }
      if (buffered >= RG_MAX_BUFFER) finish(null)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      // Drain any final partial line that still fits the caps.
      if (!settled && code === 0 && out.length < maxMatches && stdoutTail.trim().length > 0) {
        const formatted = parseMatchLine(stdoutTail.trim(), options.relativeTo)
        if (formatted !== null) out.push(formatted)
      }
      if (settled) return
      if (code === 0 || code === 1) {
        finish(null)
      } else {
        log.warn('ripgrep exited abnormally', { code, rgPath })
        finish(new Error(`ripgrep failed with exit code ${code}`))
      }
    })
  })
}
