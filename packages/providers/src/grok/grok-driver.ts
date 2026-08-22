import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapGrokLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'

const log = createLogger('providers:grok')

/**
 * Argv for a one-shot `grok -p` turn. Streaming Messages JSON yields NDJSON
 * in the Anthropic wire format; `--include-partial-messages` adds the
 * incremental stream_event deltas the mapper consumes.
 */
export function buildGrokArgs(session: AdapterSession): string[] {
  const args = [
    '-p',
    session.prompt,
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
  ]
  if (session.modelId) args.push('--model', session.modelId)
  args.push(...permissionFlags(session.permissionMode))
  if (session.resumeOf) args.push('--resume', session.resumeOf)
  return args
}

function permissionFlags(mode: PermissionMode): string[] {
  switch (mode) {
    case 'ask':
      return ['--permission-mode', 'default']
    case 'allow-edits':
      return ['--permission-mode', 'acceptEdits']
    case 'full':
      return ['--permission-mode', 'bypassPermissions']
  }
}

export class GrokDriver implements Driver {
  readonly kind = 'grok' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawnCli(this.binaryPath, buildGrokArgs(session), {
      cwd: session.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.debug('grok spawned', { pid: child.pid })

    const iterator = streamProcessEvents(child, mapGrokLine, {
      label: 'grok',
      stderrLog: (text) => log.debug('grok stderr', { text: text.slice(0, 500) }),
    })[Symbol.asyncIterator]()

    return Promise.resolve({
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => {
        if (!child.killed) child.kill()
      },
      dispose: () => {
        if (!child.killed) child.kill()
        return Promise.resolve()
      },
    })
  }
}
