import { spawn } from 'node:child_process'
import type { SourceControlError } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:source-control')

export interface GitRunOptions {
  signal?: AbortSignal
  input?: string
  maxBytes?: number
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  allowExitOne?: boolean
}

/** Bounded, cancellable Git subprocesses. Arguments are internal argv, never renderer-supplied commands. */
export class RepositoryGit {
  constructor(
    readonly cwd: string,
    readonly binary = 'git',
  ) {}

  run(
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<Result<string, SourceControlError>> {
    if (options.signal?.aborted)
      return Promise.resolve(err({ code: 'unavailable', message: 'Git request cancelled.' }))
    return new Promise((resolve) => {
      const limit = options.maxBytes ?? 4 * 1024 * 1024
      const child = spawn(
        this.binary,
        ['--no-optional-locks', '-c', 'core.longpaths=true', ...args],
        {
          cwd: this.cwd,
          shell: false,
          windowsHide: true,
          signal: options.signal,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      const chunks: Buffer[] = []
      let bytes = 0
      let overflow = false
      let timedOut = false
      let finished = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, options.timeoutMs ?? 20_000)
      const finish = (result: Result<string, SourceControlError>): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve(result)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > limit) {
          overflow = true
          child.kill()
        } else chunks.push(chunk)
      })
      child.stderr.resume()
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') log.warn('Git stdin failed', { code: error.code })
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        const missing = error.code === 'ENOENT'
        const cancelled = error.code === 'ABORT_ERR' || options.signal?.aborted
        finish(
          err({
            code: cancelled ? 'unavailable' : missing ? 'missing-tool' : 'failed',
            message: cancelled
              ? 'Git request cancelled.'
              : missing
                ? 'Git is not installed or the workspace is unavailable.'
                : 'Git could not start.',
          }),
        )
      })
      child.on('close', (code) => {
        if (overflow)
          finish(
            err({
              code: 'too-large',
              message: 'Git output exceeds the review limit. Open a smaller file.',
            }),
          )
        else if (timedOut) finish(err({ code: 'failed', message: 'Git operation timed out.' }))
        else if (options.signal?.aborted)
          finish(err({ code: 'unavailable', message: 'Git request cancelled.' }))
        else if (code !== 0 && !(options.allowExitOne && code === 1)) {
          log.warn('Git operation failed', { operation: args[0], code })
          finish(
            err({
              code: 'failed',
              message: `Git ${args[0] ?? 'operation'} failed. Check repository state and credentials.`,
            }),
          )
        } else finish(ok(Buffer.concat(chunks).toString('utf8')))
      })
      child.stdin.end(options.input)
    })
  }
}
