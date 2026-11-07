import { open } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ManagedWorkspaces } from '@ari/engine/git'
import { ControlFailure } from '@ari/contracts/agent-control'
import { orchestrationParams, type OrchestrationMethod } from '@ari/contracts/orchestration'
import type { RpcResults } from '@ari/contracts/rpc'
import { OrchestrationService } from '@ari/engine/orchestration'
import type { AgentControlService } from '@ari/engine/agent-control'
import type { Engine } from './engine'
import type { RpcRegistry } from './rpc-registry'
import { resolveScopedPath } from './path-jail'

export function createOrchestrationRuntime(
  control: AgentControlService,
  engine: Engine,
  workspaces: ManagedWorkspaces,
) {
  return new OrchestrationService({
    control,
    host: control.host,
    liveCapabilities: (id) => engine.liveCapabilities(id),
    freezeBase: async (session, key) => {
      const root = await engine.workspace(session)
      if (!root)
        throw new ControlFailure('workspace_unavailable', 'Comparison workspace is unavailable.')
      return workspaces.snapshot(root, `refs/ari/orchestration/${key}/base`)
    },
    verifySnapshot: async (session, snapshot) => {
      if (session.workspace?.kind !== 'managed-worktree')
        throw new ControlFailure(
          'unsupported',
          'Snapshot verification requires an isolated worktree.',
        )
      const cwd = session.workspace.path
      const args = ['diff', '--check', session.workspace.baseCommit, snapshot, '--']
      const outcome = await new Promise<{ exitCode: number | null; detail: string }>(
        (resolve, reject) => {
          const child = spawn('git', args, {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let detail = ''
          const append = (chunk: Buffer) => {
            detail = (detail + chunk.toString('utf8')).slice(0, 16_000)
          }
          child.stdout.on('data', append)
          child.stderr.on('data', append)
          const timer = setTimeout(() => child.kill(), 30_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('close', (exitCode) => {
            clearTimeout(timer)
            resolve({ exitCode, detail })
          })
        },
      )
      return {
        command: `git ${args.join(' ')}`,
        cwd,
        snapshotCommit: snapshot,
        exitCode: outcome.exitCode,
        detail: outcome.detail || null,
      }
    },
    readFile: async (session, relativePath, maxChars) => {
      const root = await engine.workspace(session)
      if (!root)
        throw new ControlFailure(
          'workspace_unavailable',
          'Context source workspace is unavailable.',
        )
      const target = await resolveScopedPath(root, relativePath)
      const file = await open(target, 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile())
          throw new ControlFailure('invalid_file', 'Context source must be a regular file.')
        // UTF-8 can require four bytes per character. Never read a whole large file.
        const bytes = Buffer.alloc(Math.min(stat.size, maxChars * 4 + 4))
        const read = await file.read(bytes, 0, bytes.length, 0)
        const text = bytes.subarray(0, read.bytesRead).toString('utf8')
        return {
          content: text.slice(0, maxChars),
          truncated: stat.size > read.bytesRead || text.length > maxChars,
        }
      } finally {
        await file.close()
      }
    },
  })
}

/** One typed registration boundary for renderer and connected user clients. */
export function registerOrchestrationRpc(
  registry: RpcRegistry,
  ready: Promise<{ orchestration: OrchestrationService }>,
) {
  let closed = false
  let unsubscribe: (() => void) | null = null
  void ready
    .then((runtime) => {
      if (closed) return
      unsubscribe = runtime.orchestration.subscribeChanged((frame) => {
        registry.publish(
          'orchestration.changed',
          frame,
          (params) => params['sessionId'] === frame.sessionId,
        )
      })
    })
    .catch(() => undefined)
  const register = <M extends OrchestrationMethod>(method: M) =>
    registry.register(
      method,
      async (params) =>
        (await ready).orchestration.invoke(params.sessionId, method, params, true) as Promise<
          RpcResults[M]
        >,
    )
  for (const method of Object.keys(orchestrationParams) as OrchestrationMethod[]) register(method)
  return () => {
    closed = true
    unsubscribe?.()
  }
}
