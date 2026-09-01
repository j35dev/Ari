import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { realDetectEnvironment } from '../types'
import type { DetectEnvironment } from '../types'

/**
 * Reads pi's own session files so past work can be brought into Ari.
 *
 * pi stores one JSONL file per session under a folder named after the working
 * directory, and the entries form a *tree* rather than a list: every entry
 * carries `id` and `parentId`, and `/fork` or an edited prompt adds a sibling
 * branch inside the same file. Reading the lines in order would therefore
 * replay abandoned branches as if they had happened, so a transcript is the
 * path from one leaf back to the root, reversed.
 *
 * Everything here is read-only. Ari never writes to pi's session store — the
 * import creates a new Ari journal and leaves the original file untouched, so
 * the same session stays resumable in pi afterwards.
 *
 * Format verified against pi 0.84.4 files on disk (`docs/session-format.md`,
 * schema version 3).
 */

/** One pi session file, as listed for the import picker. */
export interface PiSessionSummary {
  /** pi's own session id (the file's uuid), also its resume handle. */
  id: string
  path: string
  /** Working directory recorded in the file's header line. */
  cwd: string
  startedAt: number
  /** Mtime — the closest thing pi records to "last worked on". */
  updatedAt: number
  /** `session_info` name when set, else the first user message, else the id. */
  title: string
  /** Number of user + assistant messages on the active branch. */
  messageCount: number
  sizeBytes: number
}

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  version?: number
  cwd?: string
  name?: string
  message?: PiMessage
}

interface PiContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface PiUsage {
  input?: unknown
  output?: unknown
  cost?: { total?: unknown }
}

interface PiMessage {
  role?: string
  content?: string | PiContentBlock[]
  timestamp?: number
  usage?: PiUsage
  stopReason?: string
  errorMessage?: string
  model?: string
  provider?: string
  /** toolResult */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /** bashExecution */
  command?: string
  output?: string
  exitCode?: number
  cancelled?: boolean
}

/** Where pi keeps its sessions, honouring both documented overrides. */
export function piSessionsDir(env: DetectEnvironment = realDetectEnvironment()): string | null {
  const explicit = envVar(env, 'PI_CODING_AGENT_SESSION_DIR')
  if (explicit !== null) return explicit
  const agentDir = envVar(env, 'PI_CODING_AGENT_DIR')
  if (agentDir !== null) return join(agentDir, 'sessions')
  if (env.homeDir.length === 0) return null
  return join(env.homeDir, '.pi', 'agent', 'sessions')
}

/**
 * pi's folder name for a working directory: separators *and* the drive colon
 * each become `-`, wrapped in `--`. `D:\Projects\Ari` → `--D--Projects-Ari--`.
 *
 * Only used as a fast path — {@link listPiSessions} reads each file's header
 * for the authoritative cwd, so a future change to this encoding degrades to
 * "lists everything" rather than "finds nothing".
 */
export function piCwdFolder(cwd: string): string {
  return `--${cwd.replace(/[:/\\]/g, '-')}--`
}

/**
 * Lists pi's sessions, newest first. With `cwd` given, only sessions recorded
 * against that directory are returned. Unreadable or malformed files are
 * skipped rather than failing the listing — one corrupt file must not hide the
 * rest of a user's history.
 */
export async function listPiSessions(
  options: { cwd?: string; limit?: number } = {},
  env: DetectEnvironment = realDetectEnvironment(),
): Promise<PiSessionSummary[]> {
  const root = piSessionsDir(env)
  if (root === null) return []
  const folders = await readdir(root, { withFileTypes: true }).catch(() => null)
  if (folders === null) return []

  const wanted = options.cwd === undefined ? null : piCwdFolder(options.cwd)
  // The expected encoded folder is only an ordering hint. Every folder still
  // gets inspected because the session header's cwd is authoritative.
  const orderedFolders = [...folders].sort((a, b) =>
    a.name === wanted ? -1 : b.name === wanted ? 1 : 0,
  )
  const summaries: PiSessionSummary[] = []
  for (const folder of orderedFolders) {
    if (!folder.isDirectory()) continue
    const dir = join(root, folder.name)
    const files = await readdir(dir).catch(() => [])
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const summary = await summarize(join(dir, file)).catch(() => null)
      if (summary === null) continue
      if (options.cwd !== undefined && !(await sameDir(summary.cwd, options.cwd))) continue
      summaries.push(summary)
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return options.limit === undefined ? summaries : summaries.slice(0, options.limit)
}

/** A pi transcript, flattened to the active branch in chronological order. */
export interface PiTranscript {
  sessionId: string
  cwd: string
  startedAt: number
  title: string
  model: string | null
  entries: PiTranscriptEntry[]
}

export type PiTranscriptEntry =
  | { kind: 'user'; text: string; at: number }
  | {
      kind: 'assistant'
      at: number
      blocks: { type: 'text' | 'thinking'; text: string }[]
      toolCalls: { callId: string; name: string; argsJson: string }[]
      usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null
      errorMessage: string | null
    }
  | {
      kind: 'tool-result'
      callId: string
      name: string
      resultJson: string
      isError: boolean
      at: number
    }

/**
 * Reads one pi session file and flattens its active branch. Returns null when
 * the file is missing, is not a pi session, or carries no messages.
 */
export async function readPiTranscript(path: string): Promise<PiTranscript | null> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return null
  const entries = parseEntries(raw)
  const header = entries.find((e) => e.type === 'session')
  if (header === undefined || typeof header.id !== 'string') return null

  const branch = activeBranch(entries)
  const flattened: PiTranscriptEntry[] = []
  let model: string | null = null
  let title: string | null = nameFrom(entries)

  for (const entry of branch) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message === undefined) continue
    const at =
      typeof message.timestamp === 'number'
        ? message.timestamp
        : Date.parse(entry.timestamp ?? '') || 0
    if (typeof message.model === 'string' && message.model.length > 0) model = message.model

    if (message.role === 'user') {
      const text = plainText(message.content)
      if (text.length === 0) continue
      if (title === null) title = text
      flattened.push({ kind: 'user', text, at })
      continue
    }
    if (message.role === 'assistant') {
      flattened.push(assistantEntry(message, at))
      continue
    }
    if (message.role === 'toolResult') {
      flattened.push({
        kind: 'tool-result',
        callId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        name: typeof message.toolName === 'string' ? message.toolName : 'tool',
        resultJson: JSON.stringify({ text: plainText(message.content) }),
        isError: message.isError === true,
        at,
      })
      continue
    }
    if (message.role === 'bashExecution') {
      // A command the user ran themselves inside pi, not a tool call: it has no
      // call id to pair with, so it reads as a completed run of its own.
      const callId = `pi-bash-${flattened.length}`
      flattened.push({
        kind: 'assistant',
        at,
        blocks: [],
        toolCalls: [
          { callId, name: 'bash', argsJson: JSON.stringify({ command: message.command ?? '' }) },
        ],
        usage: null,
        errorMessage: null,
      })
      flattened.push({
        kind: 'tool-result',
        callId,
        name: 'bash',
        resultJson: JSON.stringify({ text: message.output ?? '' }),
        isError: typeof message.exitCode === 'number' && message.exitCode !== 0,
        at,
      })
    }
  }

  if (flattened.length === 0) return null
  return {
    sessionId: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : '',
    startedAt: Date.parse(header.timestamp ?? '') || 0,
    title: (title ?? header.id).slice(0, 200),
    model,
    entries: flattened,
  }
}

function assistantEntry(message: PiMessage, at: number): PiTranscriptEntry {
  const blocks: { type: 'text' | 'thinking'; text: string }[] = []
  const toolCalls: { callId: string; name: string; argsJson: string }[] = []
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.length > 0
    ) {
      blocks.push({ type: 'thinking', text: block.thinking })
    } else if (block.type === 'toolCall' && typeof block.id === 'string') {
      toolCalls.push({
        callId: block.id,
        name: typeof block.name === 'string' ? block.name : 'tool',
        argsJson: JSON.stringify(block.arguments ?? {}),
      })
    }
  }
  const usage = message.usage
  return {
    kind: 'assistant',
    at,
    blocks,
    toolCalls,
    usage:
      usage === undefined
        ? null
        : {
            inputTokens: numberOr(usage.input, 0),
            outputTokens: numberOr(usage.output, 0),
            costUsd: typeof usage.cost?.total === 'number' ? usage.cost.total : null,
          },
    errorMessage:
      message.stopReason === 'error' && typeof message.errorMessage === 'string'
        ? message.errorMessage
        : null,
  }
}

/**
 * The path from the newest leaf back to the root, in chronological order.
 *
 * Entries whose `parentId` is unknown are treated as roots so a truncated or
 * hand-edited file still yields a transcript instead of an empty one.
 */
function activeBranch(entries: PiEntry[]): PiEntry[] {
  const byId = new Map<string, PiEntry>()
  for (const entry of entries) {
    if (entry.type !== 'session' && typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  const parents = new Set<string>()
  for (const entry of byId.values()) {
    if (typeof entry.parentId === 'string') parents.add(entry.parentId)
  }
  const leaves = [...byId.values()].filter((e) => typeof e.id === 'string' && !parents.has(e.id))
  const leaf = leaves.reduce<PiEntry | null>((best, candidate) => {
    if (best === null) return candidate
    return stampOf(candidate) >= stampOf(best) ? candidate : best
  }, null)
  if (leaf === null) return []

  const path: PiEntry[] = []
  const seen = new Set<string>()
  let cursor: PiEntry | undefined = leaf
  while (cursor !== undefined && typeof cursor.id === 'string' && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.push(cursor)
    cursor = typeof cursor.parentId === 'string' ? byId.get(cursor.parentId) : undefined
  }
  return path.reverse()
}

async function summarize(path: string): Promise<PiSessionSummary | null> {
  const info = await stat(path)
  if (!info.isFile()) return null
  const transcript = await readPiTranscript(path)
  if (transcript === null) return null
  return {
    id: transcript.sessionId,
    path,
    cwd: transcript.cwd,
    startedAt: transcript.startedAt,
    updatedAt: info.mtimeMs,
    title: transcript.title,
    messageCount: transcript.entries.filter((e) => e.kind !== 'tool-result').length,
    sizeBytes: info.size,
  }
}

function parseEntries(raw: string): PiEntry[] {
  const entries: PiEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line) as PiEntry)
    } catch {
      // A partially flushed final line is normal for a live session.
    }
  }
  return entries
}

function nameFrom(entries: PiEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.type === 'session_info' && typeof entry.name === 'string' && entry.name.length > 0) {
      return entry.name
    }
  }
  return null
}

/** Text of a pi content payload, which is either a bare string or blocks. */
function plainText(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out.trim()
}

function stampOf(entry: PiEntry): number {
  return Date.parse(entry.timestamp ?? '') || entry.message?.timestamp || 0
}

async function sameDir(a: string, b: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> => {
    let path = resolve(value)
    try {
      path = await realpath(path)
    } catch {
      // A historical workspace may be gone; compare its resolved spelling.
    }
    const normalized = path.replace(/[/\\]+$/, '').replace(/\\/g, '/')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  return (await canonical(a)) === (await canonical(b))
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function envVar(env: DetectEnvironment, name: string): string | null {
  const raw = env.vars?.[name]
  return raw != null && raw.length > 0 ? raw : null
}
