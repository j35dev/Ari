import type { PermissionMode } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { mapGrokLine } from './mapper'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { promptWithAttachments } from '../attachments'
import { streamProcessEvents } from '../process-stream'
import { spawnCli } from '../spawn-cli'
import { teardownChild } from '../teardown'
import { createGrokPromptFile } from './prompt-file'

const log = createLogger('providers:grok')

/**
 * Argv for a one-shot `grok --prompt-file` turn. Streaming Messages JSON yields NDJSON
 * in the Anthropic wire format; `--include-partial-messages` adds the
 * incremental stream_event deltas the mapper consumes.
 */
export function buildGrokArgs(session: AdapterSession, promptFile: string): string[] {
  const args = [
    '--prompt-file',
    promptFile,
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
  ]
  if (session.modelId) args.push('--model', session.modelId)
  if (session.effort) args.push('--effort', session.effort)
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
  capabilities() {
    return ONE_SHOT_PROVIDER_CAPABILITIES
  }
  readonly kind = 'grok' as const

  constructor(private readonly binaryPath: string) {}

  async create(session: AdapterSession): Promise<ProviderAdapter> {
    const promptFile = await createGrokPromptFile(promptWithAttachments(session))
    let child: ReturnType<typeof spawnCli>
    try {
      child = spawnCli(this.binaryPath, buildGrokArgs(session, promptFile.path), {
        cwd: session.workspacePath,
        ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      await promptFile.dispose()
      throw error
    }
    const cleanupAfterExit = (): void => {
      void promptFile
        .dispose()
        .catch((error: unknown) => log.warn('grok prompt cleanup failed', { error: String(error) }))
    }
    child.once('close', cleanupAfterExit)
    child.on('error', (error: Error) => log.warn('grok process error', { error: error.message }))
    log.debug('grok spawned', { pid: child.pid })

    const iterator = streamProcessEvents(child, mapGrokLine, {
      label: 'grok',
      stderrLog: (text) => log.debug('grok stderr', { text: text.slice(0, 500) }),
    })[Symbol.asyncIterator]()

    return {
      capabilities: () => ONE_SHOT_PROVIDER_CAPABILITIES,
      start: () => ({ [Symbol.asyncIterator]: () => iterator }),
      interrupt: () => {
        if (!child.killed) child.kill()
      },
      dispose: async () => {
        await teardownChild(child)
        await promptFile.dispose()
      },
    }
  }
}
