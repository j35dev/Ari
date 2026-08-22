import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapCodexLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'

const log = createLogger('providers:codex')

/**
 * Argv for a one-shot `codex exec` turn. Approval/sandbox flags map Ari
 * permission modes onto codex's own policy flags.
 */
export function buildCodexArgs(session: AdapterSession): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  if (session.modelId) args.push('--model', session.modelId)
  args.push(...sandboxFlags(session.permissionMode))
  args.push(session.prompt)
  return args
}

function sandboxFlags(mode: PermissionMode): string[] {
  switch (mode) {
    case 'ask':
      return ['--ask-for-approval', 'on-request']
    case 'allow-edits':
      return ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-failure']
    case 'full':
      return ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never']
  }
}

export class CodexDriver implements Driver {
  readonly kind = 'codex' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawnCli(this.binaryPath, buildCodexArgs(session), {
      cwd: session.workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.debug('codex spawned', { pid: child.pid })

    const iterator = streamProcessEvents(child, mapCodexLine, {
      label: 'codex',
      stderrLog: (text) => log.debug('codex stderr', { text: text.slice(0, 500) }),
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
