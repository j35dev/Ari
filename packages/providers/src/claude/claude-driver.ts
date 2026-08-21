import { spawn } from 'node:child_process'
import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapClaudeLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { streamProcessEvents } from '../process-stream'

const log = createLogger('providers:claude')

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

export class ClaudeDriver implements Driver {
  readonly kind = 'claude' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawn(this.binaryPath, buildClaudeArgs(session), {
      cwd: session.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const iterator = streamProcessEvents(child, mapClaudeLine, {
      label: 'claude',
      stderrLog: (text) => log.debug('claude stderr', { text: text.slice(0, 500) }),
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
