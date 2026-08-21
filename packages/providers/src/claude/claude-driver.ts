import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { AgentEvent } from '@ari/contracts/agent-event'
import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapClaudeLine } from './mapper'
import type { Driver, ProviderAdapter, AdapterSession } from '../driver'

const log = createLogger('providers:claude')

type ClaudeProcess = ChildProcessByStdio<null, Readable, Readable>

/**
 * Builds the argv for a one-shot `claude` turn. Kept pure for tests; flag
 * drift is caught by fixture tests plus the diagnostics card (M4.15).
 */
export function buildClaudeArgs(session: AdapterSession): string[] {
  const args = ['-p', session.prompt, '--output-format', 'stream-json', '--verbose']
  if (session.modelId) args.push('--model', session.modelId)
  if (session.resumeOf) args.push('--resume', session.resumeOf)
  args.push('--permission-mode', permissionModeFlag(session.permissionMode))
  return args
}

function permissionModeFlag(mode: PermissionMode): string {
  switch (mode) {
    case 'ask':
      return 'default'
    case 'allow-edits':
      return 'acceptEdits'
    case 'full':
      return 'bypassPermissions'
  }
}

interface RunningProcess {
  child: ClaudeProcess
  interrupt: () => void
}

function spawnClaude(session: AdapterSession, binaryPath: string): RunningProcess {
  const child = spawn(binaryPath, buildClaudeArgs(session), {
    cwd: session.workspacePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return {
    child,
    interrupt: () => {
      if (!child.killed) child.kill()
    },
  }
}

async function* streamEvents(
  process: RunningProcess,
): AsyncGenerator<AgentEvent, void, undefined> {
  const { child } = process
  let buffer = ''

  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  let closed = false

  const push = (event: AgentEvent): void => {
    queue.push(event)
    notify?.()
    notify = null
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) {
        for (const event of mapClaudeLine(line)) push(event)
      }
      index = buffer.indexOf('\n')
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    log.debug('claude stderr', { text: chunk.slice(0, 500) })
  })

  const exitCode = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
  }).then((code) => {
    closed = true
    if (code !== 0 && code !== null) {
      push({ type: 'error', message: `claude exited with code ${code}`, rawJson: null })
    }
    push({ type: 'done' })
    notify?.()
    notify = null
  })

  void exitCode

  while (true) {
    while (queue.length > 0) {
      const event = queue.shift()
      if (event) yield event
      if (event?.type === 'done') return
    }
    if (closed && queue.length === 0) return
    await new Promise<void>((resolve) => {
      notify = resolve
      // Re-check after subscribing to avoid missed-notification races.
      if (queue.length > 0 || closed) resolve()
    })
  }
}

export class ClaudeDriver implements Driver {
  readonly kind = 'claude' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const running = spawnClaude(session, this.binaryPath)
    const iterator = streamEvents(running)[Symbol.asyncIterator]()
    return Promise.resolve({
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => running.interrupt(),
      dispose: () => {
        running.interrupt()
        return Promise.resolve()
      },
    })
  }
}
