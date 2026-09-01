import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { matchesAllowlist, type AllowRule } from './allowlist'
import { checkPermission } from './permissions'
import { resolveRipgrep, searchWithRipgrep } from './rg'
import { todoWriteTool } from './tools/todo'
import { GREP_MAX_LINE_CHARS, truncateHead, truncateTail } from './truncate'

const log = createLogger('ari-core:tools')

/**
 * Built-in tools for the Ari Core harness, named to match the tool vocabulary
 * frontier models are trained on (read/write/edit/grep/glob/bash). Every
 * path-touching tool is jailed to the workspace root; escapes are rejected,
 * never followed. Every result is size-capped so a single call can never
 * blow the context window.
 */

export interface ToolContext {
  workspacePath: string
  /**
   * Session permission mode (`ask` | `allow-edits` | `full`). Bash and file
   * writes are gated by it — an absent mode is treated as `ask` (fail-closed).
   */
  permissionMode?: PermissionMode
  /**
   * Permission rules scoped per tool kind. When at least one rule exists for
   * a guarded tool (bash / write / edit), calls must match a rule to run.
   * Rules intersect with the permission mode: both must pass.
   */
  allowlist?: AllowRule[]
  /** Tool names cleared for the rest of the run via an `always-allow` decision. */
  approvedTools?: ReadonlySet<string>
  /**
   * Ripgrep binary for the grep tool: explicit path, `null` to force the JS
   * fallback, or absent to auto-detect on PATH.
   */
  rgPath?: string | null
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * Declares the tool free of side effects, which lets the agent loop run it
   * concurrently with the other read-only calls in the same batch. The built-in
   * read/grep/glob/ls set it; anything mutating or external leaves it unset and
   * stays strictly ordered.
   */
  readOnly?: boolean
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

/** Resolves a user-supplied path inside the jail; throws on escape. */
async function jailed(ctx: ToolContext, input: unknown): Promise<string> {
  const rel = typeof input === 'string' ? input : ''
  const root = await fs.realpath(ctx.workspacePath).catch(() => path.resolve(ctx.workspacePath))
  const resolved = path.resolve(root, rel)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`)
  }
  // Resolve symlinks on the final target (if it exists) and re-check.
  const real = await fs.realpath(resolved).catch(() => resolved)
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`symlink escapes workspace: ${rel}`)
  }
  return resolved
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const GUARDED_TOOLS = new Set(['bash', 'write', 'edit'])

/**
 * Throws when the call is not permitted: allowlist rules apply first, then
 * the permission mode (an explicit approval clears the mode gate only —
 * the allowlist still binds even approved calls).
 */
function assertAllowed(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
): void {
  if (!GUARDED_TOOLS.has(toolName)) return
  const hasRules = (ctx.allowlist ?? []).some((r) => r.tool === toolName)
  if (hasRules && !matchesAllowlist(toolName, JSON.stringify(args), ctx.allowlist ?? [])) {
    throw new Error('blocked by permission allowlist')
  }
  if (ctx.approvedTools?.has(toolName)) return
  const decision = checkPermission(ctx.permissionMode, toolName)
  if (!decision.allowed) throw new Error(decision.reason)
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

interface ReadArgs {
  path: string
  offset?: number
  limit?: number
}

/**
 * Reads a text file with pi-style pagination: 1-indexed `offset`, optional
 * `limit`, head-truncated to 2000 lines / 50KB, and an explicit
 * continuation footer so the model always knows how to read on.
 */
async function executeRead(args: ReadArgs, ctx: ToolContext): Promise<string> {
  const target = await jailed(ctx, args.path)
  const raw = await fs.readFile(target, 'utf8')
  const allLines = raw.split('\n')
  const totalLines = allLines.length
  const start = Math.max(0, (args.offset ?? 1) - 1)
  if (start >= totalLines) {
    throw new Error(`offset ${args.offset} is beyond end of file (${totalLines} lines)`)
  }
  const slice =
    args.limit !== undefined && args.limit > 0
      ? allLines.slice(start, start + args.limit).join('\n')
      : (allLines.slice(start).join('\n') ?? '')
  const truncation = truncateHead(slice)
  let text = truncation.content
  if (truncation.truncated) {
    const nextOffset = start + truncation.outputLines + 1
    text += `\n\n[Showing lines ${start + 1}-${start + truncation.outputLines} of ${totalLines} total. Use offset=${nextOffset} to continue.]`
  } else if (args.limit !== undefined && start + args.limit < totalLines) {
    const nextOffset = start + args.limit + 1
    text += `\n\n[${totalLines - (start + args.limit)} more lines in file. Use offset=${nextOffset} to continue.]`
  }
  return text
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

interface SingleEdit {
  oldText: string
  newText: string
}

/** Accepts both the `edits[]` form and the legacy single oldString/newString. */
function parseEditArgs(args: Record<string, unknown>): { path: string; edits: SingleEdit[] } {
  const target = str(args, 'path')
  const rawEdits = args['edits']
  const edits: SingleEdit[] = []
  if (Array.isArray(rawEdits)) {
    for (const entry of rawEdits) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      edits.push({ oldText: str(record, 'oldText'), newText: str(record, 'newText') })
    }
  }
  if (edits.length === 0 && typeof args['oldString'] === 'string') {
    edits.push({ oldText: str(args, 'oldString'), newText: str(args, 'newString') })
  }
  return { path: target, edits }
}

/**
 * Exact-text replacement, pi-style: multiple disjoint edits in one call,
 * every `oldText` matched against the file as it stands after prior edits
 * and required to be unique. BOM and CRLF line endings are preserved.
 */
async function executeEdit(
  args: { path: string; edits: SingleEdit[] },
  ctx: ToolContext,
): Promise<string> {
  if (args.edits.length === 0) throw new Error('edit requires at least one {oldText, newText}')
  const target = await jailed(ctx, args.path)
  const raw = await fs.readFile(target, 'utf8')
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const content = bom !== '' ? raw.slice(1) : raw
  const crlf = content.includes('\r\n')
  let working = crlf ? content.replace(/\r\n/g, '\n') : content
  for (let i = 0; i < args.edits.length; i++) {
    const edit = args.edits[i] as SingleEdit
    const oldText = crlf ? edit.oldText.replace(/\r\n/g, '\n') : edit.oldText
    const newText = crlf ? edit.newText.replace(/\r\n/g, '\n') : edit.newText
    if (oldText.length === 0) throw new Error(`edits[${i}].oldText is empty`)
    const occurrences = working.split(oldText).length - 1
    if (occurrences === 0) {
      throw new Error(`edits[${i}].oldText not found in ${args.path}`)
    }
    if (occurrences > 1) {
      throw new Error(
        `edits[${i}].oldText matches ${occurrences} times in ${args.path}; it must be unique`,
      )
    }
    working = working.replace(oldText, newText)
  }
  const finalContent = bom + (crlf ? working.replace(/\n/g, '\r\n') : working)
  await fs.writeFile(target, finalContent, 'utf8')
  return `Applied ${args.edits.length} edit(s) to ${args.path}`
}

// ---------------------------------------------------------------------------
// grep / glob / ls
// ---------------------------------------------------------------------------

interface GrepArgs {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  limit?: number
}

const GREP_DEFAULT_LIMIT = 100

/** Searches file contents via ripgrep when available, JS walk otherwise. */
async function executeGrep(args: GrepArgs, ctx: ToolContext): Promise<string> {
  const pattern = args.pattern
  if (pattern.length === 0) throw new Error('grep requires a pattern')
  if (!args.literal) {
    // Validate the regex up front so the model gets a precise error instead
    // of a silent fallback-walk misbehaving on the same bad pattern.
    new RegExp(pattern)
  }
  const searchRoot =
    args.path === undefined || args.path === '' || args.path === '.'
      ? ctx.workspacePath
      : await jailed(ctx, args.path)
  const relative = (full: string): string =>
    path.relative(ctx.workspacePath, full).split(path.sep).join('/')
  const limit = Math.max(1, args.limit ?? GREP_DEFAULT_LIMIT)
  const matchLine = (line: string): string =>
    line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…[truncated]` : line

  const rgPath = ctx.rgPath === undefined ? await resolveRipgrep() : ctx.rgPath
  if (rgPath) {
    try {
      return await searchWithRipgrep(rgPath, pattern, searchRoot, {
        glob: args.glob,
        ignoreCase: args.ignoreCase,
        literal: args.literal,
        maxMatches: limit,
        relativeTo: ctx.workspacePath,
      })
    } catch (e) {
      // ripgrep is an accelerator; a broken binary degrades to the walk.
      log.warn('ripgrep failed; falling back to JS grep', { error: String(e) })
    }
  }

  const flags = (args.ignoreCase ?? false) ? 'gi' : 'g'
  const regex = args.literal === true
    ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
    : new RegExp(pattern, flags)
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || out.length >= limit) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        if (args.glob !== undefined && !simpleGlobMatch(relative(full), args.glob)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        const rel = relative(full)
        if (args.glob !== undefined && !simpleGlobMatch(rel, args.glob)) continue
        try {
          const content = await fs.readFile(full, 'utf8')
          const lines = content.split('\n')
          for (let i = 0; i < lines.length && out.length < limit; i++) {
            regex.lastIndex = 0
            if (regex.test(lines[i] ?? '')) {
              out.push(`${rel}:${i + 1}:${matchLine((lines[i] ?? '').trim())}`)
            }
          }
        } catch {
          // binary or unreadable — skip
        }
      }
    }
  }
  await walk(searchRoot, 0)
  return out.join('\n') || '(no matches)'
}

/** Tiny `*`-and-`**` glob matcher shared by the grep fallback and tools. */
function simpleGlobMatch(candidate: string, pattern: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${re}$`).test(candidate)
}

const GLOB_MAX_RESULTS = 200

/** Lists workspace-relative paths matching a glob pattern. */
async function executeGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = str(args, 'pattern')
  if (pattern.length === 0) throw new Error('glob requires a pattern')
  const base =
    args.path === undefined || str(args, 'path') === '' || str(args, 'path') === '.'
      ? ctx.workspacePath
      : await jailed(ctx, args.path)
  const { glob } = await import('node:fs/promises')
  const results: string[] = []
  for await (const entry of glob(pattern, { cwd: base })) {
    results.push(entry.split(path.sep).join('/'))
    if (results.length >= GLOB_MAX_RESULTS) break
  }
  if (results.length === 0) return '(no matches)'
  const suffix = results.length >= GLOB_MAX_RESULTS ? `\n[stopped at ${GLOB_MAX_RESULTS} results]` : ''
  return results.join('\n') + suffix
}

const LS_MAX_ENTRIES = 500

/** Lists one directory's entries; directories carry a trailing slash. */
async function executeLs(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const rel = str(args, 'path') || '.'
  const target = await jailed(ctx, rel)
  const entries = await fs.readdir(target, { withFileTypes: true })
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1
    const bDir = b.isDirectory() ? 0 : 1
    return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name)
  })
  const lines = entries.slice(0, LS_MAX_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  if (lines.length === 0) return '(empty directory)'
  const suffix =
    entries.length > LS_MAX_ENTRIES ? `\n[${entries.length - LS_MAX_ENTRIES} more entries]` : ''
  return lines.join('\n') + suffix
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

interface BashArgs {
  command: string
  timeout?: number
}

const BASH_DEFAULT_TIMEOUT_SECONDS = 120
const BASH_MAX_TIMEOUT_SECONDS = 600

/**
 * Runs a shell command in the workspace. Output is tail-truncated (errors
 * live at the end), non-zero exit codes are reported explicitly instead of
 * being swallowed, and `timeout` is model-controlled within a hard cap.
 */
async function executeBash(args: BashArgs, ctx: ToolContext): Promise<string> {
  const requested = args.timeout ?? BASH_DEFAULT_TIMEOUT_SECONDS
  const timeoutMs = Math.min(Math.max(1, requested), BASH_MAX_TIMEOUT_SECONDS) * 1000
  const outcome = await new Promise<{ text: string; exitCode: number | null; timedOut: boolean }>(
    (resolve) => {
      const command = args.command
      const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      const shellArg = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
      execFile(
        shell,
        shellArg,
        { cwd: ctx.workspacePath, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const raw = [stdout.toString(), stderr.toString()].filter(Boolean).join('\n')
          const truncation = truncateTail(raw)
          let text = truncation.content || '(no output)'
          if (truncation.truncated) {
            text += `\n\n[Showing lines ${truncation.firstLine}-${truncation.totalLines} of ${truncation.totalLines} (output truncated)]`
          }
          const timedOut = error instanceof Error && error.killed === true
          const code =
            error && typeof (error as NodeJS.ErrnoException).code === 'number'
              ? ((error as NodeJS.ErrnoException).code as unknown as number)
              : timedOut
                ? null
                : error
                  ? 1
                  : 0
          resolve({ text, exitCode: error ? code : 0, timedOut })
        },
      )
    },
  )
  let text = outcome.text
  if (outcome.timedOut) {
    text += `\n\n[Command timed out after ${timeoutMs / 1000} seconds and was killed]`
  } else if (outcome.exitCode !== null && outcome.exitCode !== 0) {
    text += `\n\n[Command exited with code ${outcome.exitCode}]`
  }
  return text
}

export const BUILT_IN_TOOLS: Tool[] = [
  {
    name: 'read',
    readOnly: true,
    description:
      'Read the contents of a file. Output is capped at 2000 lines / 50KB; use offset (1-indexed) and limit for large files, and follow the continuation footer to read on. Prefer this over cat or sed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace (or absolute)' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['path'],
    },
    execute: async (args, ctx) =>
      await executeRead(
        {
          path: str(args, 'path'),
          offset: num(args, 'offset'),
          limit: num(args, 'limit'),
        },
        ctx,
      ),
  },
  {
    name: 'write',
    description:
      'Create or overwrite a text file. Parent directories are created automatically. Prefer edit for modifying existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace (or absolute)' },
        content: { type: 'string', description: 'Full file contents to write' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, ctx) => {
      assertAllowed(ctx, 'write', args)
      const target = await jailed(ctx, args['path'])
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, str(args, 'content'), 'utf8')
      return `Wrote ${Buffer.byteLength(str(args, 'content'), 'utf8')} bytes to ${str(args, 'path')}`
    },
  },
  {
    name: 'edit',
    description:
      'Edit a file with exact text replacement. Pass edits: [{oldText, newText}]; each oldText must match exactly one region of the file. Combine multiple changes to one file into a single call. Keep oldText minimal but unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace (or absolute)' },
        edits: {
          type: 'array',
          description: 'One or more exact replacements, each matched uniquely against the file',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to replace (must be unique)' },
              newText: { type: 'string', description: 'Replacement text' },
            },
            required: ['oldText', 'newText'],
          },
        },
        oldString: { type: 'string', description: 'Single-replacement form: text to replace' },
        newString: { type: 'string', description: 'Single-replacement form: replacement text' },
      },
      required: ['path'],
    },
    execute: async (args, ctx) => {
      assertAllowed(ctx, 'edit', args)
      return await executeEdit(parseEditArgs(args), ctx)
    },
  },
  {
    name: 'glob',
    readOnly: true,
    description:
      'List file paths matching a glob pattern (e.g. "src/**/*.ts"). Use grep to find content matches. Respects .gitignore via the filesystem walker.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, relative to the workspace' },
        path: { type: 'string', description: 'Optional subdirectory to search under' },
      },
      required: ['pattern'],
    },
    execute: async (args, ctx) => await executeGlob(args, ctx),
  },
  {
    name: 'grep',
    readOnly: true,
    description:
      'Search file contents with a regex. Returns path:line:text matches, capped at 100 by default. Supports a glob file filter, case-insensitive search, and literal (non-regex) matching. Respects .gitignore.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
        glob: { type: 'string', description: "Filter files by glob, e.g. '*.ts'" },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search' },
        literal: { type: 'boolean', description: 'Treat the pattern as a literal string, not a regex' },
        limit: { type: 'number', description: 'Maximum number of matches (default 100)' },
      },
      required: ['pattern'],
    },
    execute: async (args, ctx) =>
      await executeGrep(
        {
          pattern: str(args, 'pattern'),
          path: str(args, 'path') || undefined,
          glob: str(args, 'glob') || undefined,
          ignoreCase: args['ignoreCase'] === true,
          literal: args['literal'] === true,
          limit: num(args, 'limit'),
        },
        ctx,
      ),
  },
  {
    name: 'ls',
    readOnly: true,
    description:
      'List the entries of a directory. Directories carry a trailing slash. Use this to explore the workspace structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (default: workspace root)' },
      },
      required: [],
    },
    execute: async (args, ctx) => await executeLs(args, ctx),
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the workspace root. Output is capped (tail kept, where errors live); non-zero exits are reported. Optional timeout in seconds (default 120, max 600).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 120, max 600)' },
      },
      required: ['command'],
    },
    execute: async (args, ctx) => {
      assertAllowed(ctx, 'bash', args)
      return await executeBash({ command: str(args, 'command'), timeout: num(args, 'timeout') }, ctx)
    },
  },
  todoWriteTool,
]

/** Looks up a built-in tool by name. */
export function findTool(name: string): Tool | undefined {
  return BUILT_IN_TOOLS.find((t) => t.name === name)
}
