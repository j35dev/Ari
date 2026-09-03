import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapHermesLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { promptWithAttachments } from '../attachments'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:hermes')

/**
 * Builds the argv for a one-shot `hermes` turn. Kept pure for tests; flag
 * drift is caught by fixture tests plus the diagnostics card (M4.15). Flags
 * mirror the documented stream-json mode; the CLI was unavailable locally so
 * they must be probed against the real binary when it ships.
 */
export function buildHermesArgs(session: AdapterSession): string[] {
  const args = ['-p', promptWithAttachments(session), '--output-format', 'stream-json', '--verbose']
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

export class HermesDriver implements Driver {
  readonly kind = 'hermes' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawnCli(this.binaryPath, buildHermesArgs(session), {
      cwd: session.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.debug('hermes spawned', { pid: child.pid })

    const iterator = streamProcessEvents(child, mapHermesLine, {
      label: 'hermes',
      stderrLog: (text) => log.debug('hermes stderr', { text: text.slice(0, 500) }),
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
