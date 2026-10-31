import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GitMutationService, watchGitChanges } from '@ari/engine/git'
import type { GitReviewService } from '@ari/engine/git'
import { gitScopeSchema } from '@ari/contracts/rpc'
import { ok } from '@ari/shared/result'
import { createLogger } from '@ari/shared/logger'
import type { RpcRegistry } from './rpc-registry'
import type { SourceControlHost } from './source-control-host'

const log = createLogger('desktop:source-control-live')
const mutationTails = new Map<string, Promise<unknown>>()
const keyFor = (root: string): string => (process.platform === 'win32' ? root.toLowerCase() : root)
interface Watched {
  ids: Set<string>
  task: ReturnType<typeof watchGitChanges>
}
interface Subscription {
  watched?: Watched
  key?: string
}
interface LiveDeps {
  busy(root: string): Promise<boolean>
  watch?: typeof watchGitChanges
}

/** Leases shared Git refs for writes and watches only subscribed worktrees. */
export class SourceControlLive {
  readonly #mutations = new WeakMap<GitReviewService, GitMutationService>()
  readonly #watched = new Map<string, Watched>()
  readonly #subscriptions = new Map<string, Subscription>()
  #revision = 0
  #closed = false
  constructor(
    readonly registry: RpcRegistry,
    readonly host: SourceControlHost,
    readonly deps: LiveDeps,
  ) {}

  register(): void {
    this.registry.register('scm.mutate', (params) =>
      this.host.withReview(params, async (review) => {
        const common = await review.git.run(['rev-parse', '--git-common-dir'])
        if (!common.ok) return common
        const key = keyFor(await realpath(resolve(review.cwd, common.value.trim())))
        let mutations = this.#mutations.get(review)
        if (!mutations) {
          mutations = new GitMutationService(review, () => this.deps.busy(review.cwd))
          this.#mutations.set(review, mutations)
        }
        const service = mutations
        const task = (mutationTails.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => service.run(params.action))
        mutationTails.set(key, task)
        try {
          return await task
        } finally {
          if (mutationTails.get(key) === task) mutationTails.delete(key)
          this.changed()
        }
      }),
    )
  }

  /** Invalidates visible readers after journaled checkpoints or Git mutations. */
  changed(): void {
    this.registry.publish('scm.changed', { revision: ++this.#revision })
  }

  watch(id: string, raw: Record<string, unknown>): void {
    const scope = gitScopeSchema.safeParse(raw)
    if (!scope.success || this.#closed) return
    this.unwatch(id)
    const subscription: Subscription = {}
    this.#subscriptions.set(id, subscription)
    void this.host
      .withReview(scope.data, (review) => Promise.resolve(ok(review)))
      .then((result) => {
        if (this.#subscriptions.get(id) !== subscription || this.#closed) return
        if (!result.ok) {
          this.registry.sendTo(id, { revision: ++this.#revision, error: result.error.message })
          return
        }
        const key = keyFor(result.value.cwd)
        let watched = this.#watched.get(key)
        if (!watched) {
          const ids = new Set<string>()
          const notify = (error?: string): void => {
            const payload = { revision: ++this.#revision, ...(error ? { error } : {}) }
            for (const subscriber of ids) this.registry.sendTo(subscriber, payload)
          }
          const task = (this.deps.watch ?? watchGitChanges)(result.value.cwd, notify)
          watched = { ids, task }
          this.#watched.set(key, watched)
          void task
            .then((watch) => {
              if (!watch.ok) notify(watch.error.message)
            })
            .catch((error: unknown) => {
              log.warn('Source-control watch failed', { error: String(error) })
              notify('Live refresh is unavailable. Refresh manually.')
            })
        }
        watched.ids.add(id)
        subscription.key = key
        subscription.watched = watched
      })
      .catch((error: unknown) =>
        log.warn('Source-control scope unavailable', { error: String(error) }),
      )
  }

  unwatch(id: string): void {
    const subscription = this.#subscriptions.get(id)
    this.#subscriptions.delete(id)
    const watched = subscription?.watched
    if (!watched) return
    watched.ids.delete(id)
    if (watched.ids.size) return
    this.#watched.delete(subscription.key!)
    void watched.task
      .then(async (result) => {
        if (result.ok) await result.value()
      })
      .catch((error: unknown) => log.warn('Git watch cleanup failed', { error: String(error) }))
  }

  /** Releases subscriptions even when watcher startup is still pending. */
  close(): void {
    this.#closed = true
    for (const id of this.#subscriptions.keys()) this.unwatch(id)
  }
}
