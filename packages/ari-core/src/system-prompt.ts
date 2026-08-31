import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * System-prompt construction for the Ari Core harness, modeled on the
 * assembly order used by production coding agents (pi, omp): identity,
 * tool inventory, guidelines, environment facts, workspace layout, git
 * state, and the user's own project instruction files. Everything except
 * identity is gathered fail-soft — a missing piece is omitted, never fatal.
 */

/** One-line snippet per built-in tool, rendered into the prompt. */
const TOOL_SNIPPETS: readonly (readonly [string, string])[] = [
  ['read', 'Read a file (paginated, with continuation footers)'],
  ['write', 'Create or overwrite a file'],
  ['edit', 'Exact-text replacements in a file (multiple edits per call)'],
  ['glob', 'List file paths matching a glob pattern'],
  ['grep', 'Regex content search across files (ripgrep-backed)'],
  ['ls', 'List directory entries'],
  ['bash', 'Run shell commands in the workspace'],
  ['todo_write', 'Maintain a structured task list for the current work'],
]

const GUIDELINES: readonly string[] = [
  'Explore before acting: ls/glob to map the workspace, read before editing any file.',
  'Use edit for precise changes; keep each oldText minimal but unique in the file.',
  'After changes, verify with bash (tests, typechecks, builds) when feasible.',
  'Be concise in responses; show file paths clearly when working with files.',
]

/** Instruction files discovered at the workspace root, in priority order. */
const CONTEXT_FILE_NAMES = ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md'] as const

/** Char budget for all project instruction files combined. */
const MAX_CONTEXT_FILE_CHARS = 12_000
/** Char budget for the workspace layout listing. */
const MAX_LAYOUT_ENTRIES = 40
/** Directories never expanded in the workspace layout. */
const LAYOUT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv'])

export interface SystemPromptOptions {
  workspacePath: string
  /** Char budget override for project instruction files (tests). */
  maxContextFileChars?: number
}

function runGit(workspacePath: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: workspacePath, timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        resolve(error ? null : stdout.toString().trim())
      },
    )
  })
}

/** Branch and a compact dirty-file count; null when not a git repo. */
async function gitSummary(workspacePath: string): Promise<string | null> {
  const branch = await runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === null) return null
  const status = await runGit(workspacePath, ['status', '--porcelain'])
  if (status === null || status.length === 0) return `Git branch: ${branch} (clean)`
  const files = status.split('\n').filter((l) => l.trim().length > 0)
  return `Git branch: ${branch} (${files.length} changed file${files.length === 1 ? '' : 's'})`
}

/** Top-level workspace layout: dirs first, then files, capped. */
async function workspaceLayout(workspacePath: string): Promise<string | null> {
  let entries
  try {
    entries = await fs.readdir(workspacePath, { withFileTypes: true })
  } catch {
    return null
  }
  const names = entries
    .filter((e) => !LAYOUT_SKIP.has(e.name))
    .sort((a, b) => {
      const aDir = a.isDirectory() ? 0 : 1
      const bDir = b.isDirectory() ? 0 : 1
      return aDir !== bDir ? aDir - bDir : a.name.localeCompare(b.name)
    })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  if (names.length === 0) return null
  const shown = names.slice(0, MAX_LAYOUT_ENTRIES)
  const suffix =
    names.length > MAX_LAYOUT_ENTRIES ? `\n... (${names.length - MAX_LAYOUT_ENTRIES} more)` : ''
  return shown.join('\n') + suffix
}

export interface ProjectContextFile {
  path: string
  content: string
}

/**
 * Reads the workspace's instruction files (AGENTS.md, CLAUDE.md, …) up to a
 * combined char budget, most specific (override) first. Exported for tests.
 */
export async function loadContextFiles(
  workspacePath: string,
  maxChars = MAX_CONTEXT_FILE_CHARS,
): Promise<ProjectContextFile[]> {
  const out: ProjectContextFile[] = []
  let budget = maxChars
  for (const name of CONTEXT_FILE_NAMES) {
    if (budget <= 0) break
    const full = path.join(workspacePath, name)
    let content: string
    try {
      content = await fs.readFile(full, 'utf8')
    } catch {
      continue
    }
    const trimmed = content.length > budget ? `${content.slice(0, budget)}\n[truncated]` : content
    out.push({ path: name, content: trimmed })
    budget -= trimmed.length
  }
  return out
}

function osDescription(): string {
  const release = process.env['OS'] ?? ''
  if (process.platform === 'win32') return `Windows (${release || 'win32'})`
  return `${process.platform}`
}

function shellDescription(): string {
  return process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
}

/**
 * Builds the Ari Core system prompt for one session. The exact tool list is
 * derived from {@link TOOL_SNIPPETS}; environment facts anchor the model to
 * the workspace it is operating in.
 */
export async function buildSystemPrompt(options: SystemPromptOptions): Promise<string> {
  const { workspacePath } = options
  const promptCwd = workspacePath.replace(/\\/g, '/')

  const [git, layout, contextFiles] = await Promise.all([
    gitSummary(workspacePath),
    workspaceLayout(workspacePath),
    loadContextFiles(workspacePath, options.maxContextFileChars),
  ])

  const tools = TOOL_SNIPPETS.map(([name, snippet]) => `- ${name}: ${snippet}`).join('\n')
  const guidelines = GUIDELINES.map((g) => `- ${g}`).join('\n')

  let prompt = `You are Ari Core, an expert coding agent embedded in the Ari desktop app. You help users by reading files, executing commands, editing code, and writing new files inside their workspace.

Available tools:
${tools}

Guidelines:
${guidelines}`

  prompt += `

Environment:
- Working directory: ${promptCwd}
- Platform: ${osDescription()}
- Shell: ${shellDescription()}
- Is git repository: ${git === null ? 'no' : 'yes'}${git !== null ? `\n- ${git}` : ''}
- Today's date: ${new Date().toISOString().slice(0, 10)}`

  if (layout !== null) {
    prompt += `

Workspace layout (top level):
${layout}`
  }

  if (contextFiles.length > 0) {
    prompt += '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n'
    for (const file of contextFiles) {
      prompt += `\n<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n`
    }
    prompt += '</project_context>'
  }

  return prompt
}
