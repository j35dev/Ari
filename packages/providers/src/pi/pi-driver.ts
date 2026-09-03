import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapPiLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { promptWithAttachments } from '../attachments'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:pi')

/**
 * Argv for a one-shot `pi --mode json` turn. pi's print mode has no approval
 * channel, so Ari permission modes map onto tool capability flags:
 * ask → read-only tools, allow-edits → everything except bash, full → all.
 */
export function buildPiArgs(session: AdapterSession): string[] {
  const args = ['--mode', 'json', '--no-session']
  args.push(...permissionFlags(session.permissionMode))
  if (session.modelId) args.push('--model', session.modelId)
  if (session.resumeOf) args.push('--session', session.resumeOf)
  args.push('-p', promptWithAttachments(session))
  return args
}

function permissionFlags(mode: PermissionMode): string[] {
  switch (mode) {
    case 'ask':
      return ['--tools', 'read,grep,find,ls']
    case 'allow-edits':
      return ['--exclude-tools', 'bash']
    case 'full':
      return []
  }
}

export class PiDriver implements Driver {
  readonly kind = 'pi' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawnCli(this.binaryPath, buildPiArgs(session), {
      cwd: session.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.debug('pi spawned', { pid: child.pid })

    const iterator = streamProcessEvents(child, mapPiLine, {
      label: 'pi',
      stderrLog: (text) => log.debug('pi stderr', { text: text.slice(0, 500) }),
    })[Symbol.asyncIterator]()

    return Promise.resolve({
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => {
        if (!child.killed) child.kill()
      },
      dispose: () => teardownChild(child),
    })
  }
}
