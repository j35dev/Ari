import { accessSync, constants } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { createLogger } from '@ari/shared/logger'
import type { ContentSearchMatch } from '@ari/contracts/rpc'
import { spawnCli } from '@ari/providers/spawn-cli'

const log = createLogger('desktop:search')

/** Default result ceiling (`maxResults` may lower it, never raise it past 200). */
export const SEARCH_DEFAULT_MAX_RESULTS = 200
/** Wall-clock budget for one search, shared by rg and the JS fallback. */
export const SEARCH_TIMEOUT_MS = 3_000
/** Stdout byte cap for one rg run; exceeded means rg is killed and results kept. */
const RG_MAX_BUFFER = 1024 * 1024
/** Files larger than this are skipped by the JS fallback (artifact guard). */
const WALK_MAX_FILE_BYTES = 1024 * 1024
/** Directory-depth bound for the JS fallback. */
const WALK_MAX_DEPTH = 10

export interface ContentSearchOptions {
  /** Ripgrep binary; `null` forces the JS walk, `undefined` resolves from PATH. */
  rgPath?: string | null
  timeoutMs?: number
  maxResults?: number
}

let cachedRgPath: Promise<string | null> | null = null

/**
 * Resolves the ripgrep binary from PATH (`rg.exe` / `rg`), memoized for the
 * process lifetime. Returns null when no executable copy is found.
 */
export function resolveSearchRipgrep(): Promise<string | null> {
  cachedRgPath ??= Promise.resolve(scanPathForRg())
  return cachedRgPath
}

/** Clears the memoized PATH scan (test hook). */
export function resetSearchRipgrepCache(): void {
  cachedRgPath = null
}

function scanPathForRg(): string | null {
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

/**
 * True when `candidate` stays inside `root`. Relative candidates anchor to
 * the root itself; absolute ones must already point back into it.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const base = path.resolve(root)
  const rel = path.relative(base, path.resolve(base, candidate))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Parses one `path:line:text` row; null when malformed or line < 1. */
function parseMatchLine(line: string): ContentSearchMatch | null {
  const match = /^(.+):(\d+):(.*)$/.exec(line)
  if (match?.[1] === undefined || match?.[2] === undefined || match?.[3] === undefined) return null
  const lineNumber = Number(match[2])
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null
  if (match[1].length === 0) return null
  return { path: match[1], line: lineNumber, text: match[3].trim().slice(0, 200) }
}

/**
 * Runs ripgrep for a literal, case-insensitive needle under `root` and parses
 * `path:line:text` rows into matches. Resolves with whatever fits the caps;
 * rejects on abnormal exit so callers can fall back to the JS walk.
 */
function ripgrepSearch(
  rgPath: string,
  query: string,
  root: string,
  budgetMs: number,
  maxResults: number,
): Promise<ContentSearchMatch[]> {
  return new Promise((resolve, reject) => {
    // Same Windows rules as every other CLI spawn: direct argv for native
    // executables, fully-escaped cmd.exe wrapper otherwise, never shell:true
    // with raw query text (M15.5).
    const argv = [
      '--fixed-strings',
      '--ignore-case',
      '--line-number',
      '--no-heading',
      '--no-messages',
      query,
      '.',
    ]
    const child = spawnCli(rgPath, argv, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: ContentSearchMatch[] = []
    let buffered = 0
    let settled = false
    let tail = ''

    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (err !== null) reject(err)
      else resolve(out)
    }

    const timer = setTimeout(() => finish(new Error(`ripgrep timed out after ${budgetMs}ms`)), budgetMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.length
      tail += chunk.toString('utf8')
      while (out.length < maxResults) {
        const newlineAt = tail.indexOf('\n')
        if (newlineAt === -1) break
        // Strip CRLF's trailing \r — `.`/`$` in the match regex never match it.
        const line = tail.slice(0, newlineAt).replace(/\r$/, '')
        tail = tail.slice(newlineAt + 1)
        // Relative paths only (we search `.`), so the greedy `path:line:` split
        // survives Windows drive letters; the jail re-check is defense-in-depth.
        const match = parseMatchLine(line)
        if (match && isInsideRoot(root, match.path)) {
          out.push(match)
        }
        if (out.length >= maxResults || buffered >= RG_MAX_BUFFER) {
          finish(null)
          return
        }
      }
      if (buffered >= RG_MAX_BUFFER) finish(null)
    })
    child.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))))
    child.on('close', (code) => {
      if (settled) return
      if (code === 0 || code === 1) {
        // Drain a final partial line that still fits the caps.
        if (code === 0 && out.length < maxResults && tail.trim().length > 0) {
          const match = parseMatchLine(tail.trim())
          if (match && isInsideRoot(root, match.path)) {
            out.push(match)
          }
        }
        finish(null)
      } else {
        log.warn('ripgrep exited abnormally', { code, rgPath })
        finish(new Error(`ripgrep failed with exit code ${code}`))
      }
    })
  })
}

/**
 * Depth-limited directory walk scanning text files for the needle. Skips
 * `node_modules`, hidden/dot directories and symlinked entries (so listings
 * cannot leave the root), oversized files, and anything past the deadline.
 */
async function walkSearch(
  query: string,
  root: string,
  deadline: number,
  maxResults: number,
): Promise<ContentSearchMatch[]> {
  const needle = query.toLowerCase()
  const out: ContentSearchMatch[] = []
  const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || Date.now() >= deadline || out.length >= maxResults) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= maxResults || Date.now() >= deadline) return
      if (entry.isSymbolicLink()) continue
      const rel = path.join(relDir, entry.name)
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        await walk(full, rel, depth + 1)
      } else if (entry.isFile()) {
        try {
          const size = (await stat(full)).size
          if (size > WALK_MAX_FILE_BYTES) continue
          const content = await readFile(full, 'utf8')
          const lines = content.split('\n')
          for (const [index, raw] of lines.entries()) {
            if (out.length >= maxResults) return
            if (raw.toLowerCase().includes(needle)) {
              out.push({ path: rel, line: index + 1, text: raw.trim().slice(0, 200) })
            }
          }
        } catch {
          // binary or unreadable — skip
        }
      }
    }
  }
  await walk(root, '', 0)
  return out
}

/**
 * Project-wide content search (M18.4 over IPC): literal, case-insensitive
 * needle across the folder rooted at `root`, served by ripgrep when present
 * (spawned through @ari/providers/spawn-cli) with a depth-limited JS walk as
 * fallback. Results are capped (default {@link SEARCH_DEFAULT_MAX_RESULTS}) and
 * time-boxed ({@link SEARCH_TIMEOUT_MS}); every returned path is jailed to
 * `root`.
 */
export async function searchProjectContent(
  root: string,
  query: string,
  options: ContentSearchOptions = {},
): Promise<ContentSearchMatch[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  const info = await stat(root).catch(() => null)
  if (info === null) throw new Error('path does not exist')
  if (!info.isDirectory()) throw new Error('not a directory')

  const maxResults = Math.min(options.maxResults ?? SEARCH_DEFAULT_MAX_RESULTS, SEARCH_DEFAULT_MAX_RESULTS)
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  const rgPath = options.rgPath === undefined ? await resolveSearchRipgrep() : options.rgPath
  if (rgPath !== null) {
    try {
      return await ripgrepSearch(rgPath, trimmed, root, Math.max(1, deadline - Date.now()), maxResults)
    } catch (error) {
      // ripgrep is an accelerator; a broken/hung binary degrades to the walk.
      log.warn('ripgrep search failed; falling back to JS walk', { error: String(error) })
    }
  }
  return walkSearch(trimmed, root, deadline, maxResults)
}
