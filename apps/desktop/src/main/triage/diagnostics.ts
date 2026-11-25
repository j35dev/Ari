import { open, mkdir, stat, writeFile, appendFile, readFile } from 'node:fs/promises'
import { homedir, hostname, release } from 'node:os'
import { dirname } from 'node:path'
import type { TriageContext } from '@ari/contracts/triage'

export const LOG_LIMIT = 1_048_576
export function redact(text: string): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '[redacted]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]+)\b/g,
      '[redacted]',
    )
    .replace(
      /(?<![\w-])((?:["']?)(?:[\w-]{0,64}(?:token|secret|password|api[_-]?key|authorization)[\w-]{0,64})(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;\n}]+)/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .split(homedir())
    .join('<home>')
    .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s"']+/gi, '<home>')
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, '<home>')
}

/**
 * The error a log call carries — the data itself or its `error` field — as
 * its message and stack. Nothing else from the data: it can hold conversations.
 */
export function errorDetail(data: unknown): string | undefined {
  const error =
    data instanceof Error
      ? data
      : typeof data === 'object' && data !== null && 'error' in data
        ? data.error
        : undefined
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return typeof error === 'string' && error.length > 0 ? error : undefined
}

/** Only warning/error messages and the errors they carry are retained. */
export class TriageLog {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  constructor(readonly path: string) {}
  record(scope: string, message: string, error?: string): void {
    if (this.pending >= 256) return
    this.pending++
    const line =
      JSON.stringify({
        at: Date.now(),
        scope: redact(scope.slice(0, 100)),
        message: redact(message.slice(0, 8000)),
        ...(error ? { error: redact(error.slice(0, 8000)) } : {}),
      }) + '\n'
    this.tail = this.tail
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true })
        const size = await stat(this.path)
          .then((s) => s.size)
          .catch(() => 0)
        if (size + Buffer.byteLength(line) > LOG_LIMIT) await writeFile(this.path, '', 'utf8')
        await appendFile(this.path, line, 'utf8')
      })
      .catch(() => undefined)
      .finally(() => {
        this.pending--
      })
  }
  async recent(): Promise<string> {
    await this.tail
    const text = await readTail(this.path, LOG_LIMIT)
    const cutoff = Date.now() - 15 * 60_000
    return text
      .split('\n')
      .filter((line) => {
        try {
          const item: unknown = JSON.parse(line)
          return (
            typeof item === 'object' &&
            item !== null &&
            'at' in item &&
            typeof item.at === 'number' &&
            item.at >= cutoff
          )
        } catch {
          return false
        }
      })
      .join('\n')
  }
  flush(): Promise<void> {
    return this.tail
  }
}

export async function readTail(path: string, max: number): Promise<string> {
  try {
    const file = await open(path, 'r')
    try {
      const size = (await file.stat()).size
      const bytes = Buffer.alloc(Math.min(size, max))
      await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length))
      return bytes.toString('utf8')
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function collectContext(input: {
  appVersion: string
  buildCommit: string | null
  profile: string
  providers: TriageContext['providers']
  log: TriageLog
}): Promise<TriageContext> {
  return {
    version: 1,
    appVersion: input.appVersion,
    buildCommit: input.buildCommit,
    profile: input.profile,
    machine: hostname(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? null,
    collectedAt: Date.now(),
    providers: input.providers,
    logs: await input.log.recent(),
    exclusions: [
      'Credentials and environment variables',
      'Project files and source code',
      'Prompts and conversation history',
      'Terminal transcripts',
      'Screenshots unless added to the conversation',
    ],
  }
}

/** Strictly bounded reads for agent-written drafts; callers validate the parsed structure. */
export async function boundedJson(path: string, max = 256_000): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > max) throw new Error('This triage file is too large.')
    const bytes = Buffer.alloc(max + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > max) throw new Error('This triage file is too large.')
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as unknown
  } finally {
    await file.close()
  }
}

export async function savedContext(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
