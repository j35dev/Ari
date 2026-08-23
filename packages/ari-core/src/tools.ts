import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { PermissionMode } from '@ari/contracts/common'
import { matchesAllowlist, type AllowRule } from './allowlist'
import { checkPermission } from './permissions'
import { todoWriteTool } from './tools/todo'

/**
 * Built-in tools for the Ari Core harness. Every path-touching tool is
 * jailed to the workspace root; escapes are rejected, never followed.
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
   * a guarded tool (bash / write_file / edit_file), calls must match a rule
   * to run. Rules intersect with the permission mode: both must pass.
   */
  allowlist?: AllowRule[]
  /** Tool names cleared for the rest of the run via an `always-allow` decision. */
  approvedTools?: ReadonlySet<string>
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
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

const GUARDED_TOOLS = new Set(['bash', 'write_file', 'edit_file'])

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

export const BUILT_IN_TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a text file inside the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path' } },
      required: ['path'],
    },
    execute: async (args, ctx) => await fs.readFile(await jailed(ctx, args['path']), 'utf8'),
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    execute: async (args, ctx) => {
        assertAllowed(ctx, 'write_file', args)
        const target = await jailed(ctx, args['path'])
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, str(args, 'content'), 'utf8')
      return `wrote ${str(args, 'content').length} bytes to ${str(args, 'path')}`
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact substring in a file. Fails unless oldString occurs exactly once.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
      },
      required: ['path', 'oldString', 'newString'],
    },
    execute: async (args, ctx) => {
        assertAllowed(ctx, 'edit_file', args)
        const target = await jailed(ctx, args['path'])
      const content = await fs.readFile(target, 'utf8')
      const oldStr = str(args, 'oldString')
      const occurrences = content.split(oldStr).length - 1
      if (occurrences === 0) throw new Error('oldString not found')
      if (occurrences > 1) throw new Error(`oldString matches ${occurrences} times; must be unique`)
      await fs.writeFile(target, content.replace(oldStr, str(args, 'newString')), 'utf8')
      return 'edited'
    },
  },
  {
    name: 'glob',
    description: 'List files matching a glob pattern relative to the workspace.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
    execute: async (args, ctx) => {
      const { glob } = await import('node:fs/promises')
      const results: string[] = []
      for await (const entry of glob(str(args, 'pattern'), { cwd: ctx.workspacePath })) {
        results.push(entry)
        if (results.length >= 200) break
      }
      return results.join('\n') || '(no matches)'
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a literal string; returns path:line matches.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
    execute: async (args, ctx) => {
      const needle = str(args, 'pattern')
      const out: string[] = []
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 6 || out.length >= 100) return
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (out.length >= 100) return
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
            await walk(full, depth + 1)
          } else if (entry.isFile()) {
            try {
              const content = await fs.readFile(full, 'utf8')
              content.split('\n').forEach((line, i) => {
                if (out.length < 100 && line.includes(needle)) {
                  out.push(`${path.relative(ctx.workspacePath, full)}:${i + 1}:${line.trim().slice(0, 120)}`)
                }
              })
            } catch {
              // binary or unreadable — skip
            }
          }
        }
      }
      await walk(ctx.workspacePath, 0)
      return out.join('\n') || '(no matches)'
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command in the workspace. 30s timeout, 64KB output cap.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    execute: async (args, ctx) => {
      assertAllowed(ctx, 'bash', args)
      return await new Promise<string>((resolve) => {
        const command = str(args, 'command')
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
        const shellArg = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
        execFile(
          shell,
          shellArg,
          { cwd: ctx.workspacePath, timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true },
          (_error, stdout, stderr) => {
            const out = [stdout.toString(), stderr.toString()].filter(Boolean).join('\n')
            resolve(out || '(no output)')
          },
        )
      })
    },
  },
  todoWriteTool,
]

/** Looks up a built-in tool by name. */
export function findTool(name: string): Tool | undefined {
  return BUILT_IN_TOOLS.find((t) => t.name === name)
}
