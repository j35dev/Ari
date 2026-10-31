import { realpath } from 'node:fs/promises'
import { GitReviewService, readGitHistory } from '@ari/engine/git'
import type { GitScope, SourceControlError } from '@ari/contracts/rpc'
import type { SessionReadModel } from '@ari/engine/projection'
import { err, ok, type Result } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'
import type { RpcRegistry } from './rpc-registry'

const log = createLogger('desktop:source-control')
interface SourceControlDeps {
  root(scope: GitScope): Promise<string>
  session(id: string): Promise<SessionReadModel>
}

/** Owns capability-scoped snapshots and cancellation for desktop review queries. */
export class SourceControlHost {
  readonly #entries = new Map<string, GitReviewService>()
  readonly #requests = new Map<string, AbortController>()
  #closed = false
  constructor(
    readonly registry: RpcRegistry,
    readonly deps: SourceControlDeps,
  ) {}

  async #entry(scope: GitScope): Promise<GitReviewService> {
    const root = await realpath(await this.deps.root(scope))
    if (this.#closed) throw new Error('Source control is closed')
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    let saved = this.#entries.get(key)
    if (!saved) {
      if (this.#entries.size >= 32) this.#entries.delete(this.#entries.keys().next().value!)
      saved = new GitReviewService(root)
      this.#entries.set(key, saved)
    }
    return saved
  }

  async #read<T>(
    scope: GitScope,
    id: string | undefined,
    run: (review: GitReviewService, signal: AbortSignal) => Promise<Result<T, SourceControlError>>,
  ): Promise<Result<T, SourceControlError>> {
    const controller = new AbortController()
    if (id) {
      this.#requests.get(id)?.abort()
      this.#requests.set(id, controller)
    }
    try {
      const entry = await this.#entry(scope)
      if (controller.signal.aborted)
        return err({ code: 'unavailable', message: 'Request cancelled.' })
      return await run(entry, controller.signal)
    } catch (error) {
      log.warn('Source-control request failed', { error: String(error) })
      return err({
        code: 'unavailable',
        message: 'This workspace is unavailable. Reopen it and retry.',
      })
    } finally {
      if (id && this.#requests.get(id) === controller) this.#requests.delete(id)
    }
  }

  /** Runs a main-process operation against the same scoped snapshot cache as review reads. */
  withReview<T>(
    scope: GitScope,
    run: (review: GitReviewService) => Promise<Result<T, SourceControlError>>,
  ): Promise<Result<T, SourceControlError>> {
    return this.#read(scope, undefined, run)
  }

  register(): void {
    const r = this.registry
    r.register('scm.cancel', ({ requestId }) => {
      const request = this.#requests.get(requestId)
      request?.abort()
      return { cancelled: !!request }
    })
    r.register('scm.summary', (scope) =>
      this.#read(scope, scope.requestId, (review, signal) => review.summary(signal)),
    )
    r.register('scm.status', (scope) =>
      this.#read(scope, scope.requestId, async (review, signal) => {
        const status = await review.status(signal)
        if (!status.ok) return status
        const refs = await review.refs(signal)
        if (!refs.ok) return refs
        const history = await readGitHistory(review.git, status.value, signal)
        if (!history.ok) return history
        const model = scope.sessionId ? await this.deps.session(scope.sessionId) : null
        return ok({
          status: status.value,
          refs: refs.value,
          ...history.value,
          turns:
            model?.checkpoints.map((checkpoint) => ({
              turnId: checkpoint.turnId,
              stable: !!checkpoint.endRef,
              ...(checkpoint.endError ? { error: checkpoint.endError } : {}),
            })) ?? [],
        })
      }),
    )
    r.register('scm.review', (params) =>
      this.#read(params, params.requestId, async (review, signal) => {
        const model = params.sessionId ? await this.deps.session(params.sessionId) : null
        const comparison = params.comparison
        const checkpoint =
          comparison.kind === 'turn'
            ? model?.checkpoints.find((entry) => entry.turnId === comparison.turnId)
            : null
        if (checkpoint?.endError) return err({ code: 'unavailable', message: checkpoint.endError })
        const workspace = model?.session?.workspace
        const base =
          comparison.kind === 'session'
            ? (model?.sessionBaselineRef ??
              (workspace?.kind === 'managed-worktree' ? workspace.baseCommit : undefined) ??
              model?.checkpoints[0]?.gitRef)
            : checkpoint?.gitRef
        return review.manifest(comparison, { base, head: checkpoint?.endRef }, signal)
      }),
    )
    r.register('scm.diff', (params) =>
      this.#read(params, params.requestId, (review, signal) =>
        review.diff(params.snapshotId, params.path, params.context, signal),
      ),
    )
  }

  /** Stops pending reads when the desktop window closes. */
  close(): void {
    this.#closed = true
    for (const request of this.#requests.values()) request.abort()
    this.#entries.clear()
  }
}
