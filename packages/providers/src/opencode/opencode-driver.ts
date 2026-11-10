import { createLogger } from '@ari/shared/logger'
import { mapOpencodeLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { promptWithAttachments } from '../attachments'
import { streamProcessEvents } from '../process-stream'
import { spawnCli, writeCliPrompt } from '../spawn-cli'
import { teardownChild } from '../teardown'

const log = createLogger('providers:opencode')

/**
 * Argv for a one-shot `opencode run` turn. OpenCode exposes no per-mode
 * permission flags: only a global `--auto` approve-all switch exists, so
 * `ask`/`allow-edits` runs with the CLI default (ask) and only `full`
 * escalates. The args-builder tests pin this behavior.
 */
export function buildOpencodeArgs(session: AdapterSession): string[] {
  if (session.effort)
    throw new Error(
      'The legacy OpenCode transport cannot apply reasoning effort. Enable ACP or select a supported provider.',
    )
  const args = ['run', '--format', 'json', '--thinking']
  if (session.modelId) args.push('--model', session.modelId)
  if (session.resumeOf) args.push('--session', session.resumeOf)
  if (session.permissionMode === 'full') args.push('--auto')
  return args
}

export class OpencodeDriver implements Driver {
  capabilities() {
    return ONE_SHOT_PROVIDER_CAPABILITIES
  }
  readonly kind = 'opencode' as const

  constructor(private readonly binaryPath: string) {}

  create(session: AdapterSession): Promise<ProviderAdapter> {
    const child = spawnCli(this.binaryPath, buildOpencodeArgs(session), {
      cwd: session.workspacePath,
      ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    log.debug('opencode spawned', { pid: child.pid })
    // `run` appends piped stdin to its message, so leave the positional message empty.
    writeCliPrompt(child.stdin, promptWithAttachments(session))

    const iterator = streamProcessEvents(child, mapOpencodeLine, {
      label: 'opencode',
      stderrLog: (text) => log.debug('opencode stderr', { text: text.slice(0, 500) }),
    })[Symbol.asyncIterator]()

    return Promise.resolve({
      capabilities: () => ONE_SHOT_PROVIDER_CAPABILITIES,
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => {
        if (!child.killed) child.kill()
      },
      dispose: () => teardownChild(child),
    })
  }
}
