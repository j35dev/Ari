import { realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { GitMutationService, ship, watchGitChanges } from '@ari/engine/git'
import { currentPullRequest, forget as forgetPullRequest, openPullRequest } from './pull-request'
import { sourceControlEnvironment } from './source-control-environment'
import type { GitReviewService } from '@ari/engine/git'
import { gitScopeSchema } from '@ari/contracts/rpc'
import { err, ok } from '@ari/shared/result'
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
  sessionId?: string
  pending?: Promise<void>
}
interface LiveDeps {
  busy(root: string): Promise<boolean>
  watch?: typeof watchGitChanges
  /** Whether new pull requests open as drafts (Settings → Source control). */
  draftPullRequests?: () => boolean
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
    this.registry.register('scm.ship', (params) =>
      this.host.withReview(params, async (review) => {
        const common = await review.git.run(['rev-parse', '--git-common-dir'])
        if (!common.ok) return common
        const key = keyFor(await realpath(resolve(review.cwd, common.value.trim())))
        const task = (mutationTails.get(key) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            if (params.action !== 'fetch' && (await this.deps.busy(review.cwd)))
              return err({
                code: 'busy' as const,
                message: 'Wait for the active agent turn to finish before changing Git state.',
              })
            return ship(
              review,
              {
                action: params.action,
                ...(params.message !== undefined ? { message: params.message } : {}),
                ...(params.paths !== undefined ? { paths: params.paths } : {}),
              },
              {
                createPr: (signal) =>
                  this.host.deps.hosting
                    ? this.host.deps.hosting.create(
                        review,
                        this.deps.draftPullRequests?.() ?? false,
                        signal,
                      )
                    : openPullRequest(review.cwd, {
                        ...(signal ? { signal } : {}),
                        draft: this.deps.draftPullRequests?.() ?? false,
                      }),
              },
            )
          })
        mutationTails.set(key, task)
        try {
          return await task
        } finally {
          if (mutationTails.get(key) === task) mutationTails.delete(key)
          forgetPullRequest(review.cwd)
          this.changed()
        }
      }),
    )
    this.registry.register('scm.environment', async () => ({
      ...(await sourceControlEnvironment()),
      connections: this.host.deps.hosting?.api.connections.list() ?? [],
    }))
    this.registry.register('scm.connect', async (params) => {
      const result =
        (await this.host.deps.hosting?.connect(params)) ??
        err({ code: 'unavailable', message: 'Hosting connections are unavailable.' })
      if (result.ok) this.changed()
      return result
    })
    this.registry.register('scm.disconnect', (params) => {
      try {
        const removed = this.host.deps.hosting?.api.connections.remove(params.id) ?? false
        if (removed) this.changed()
        return ok(removed)
      } catch {
        return err({ code: 'failed', message: 'Could not remove this connection. Retry.' })
      }
    })
    this.registry.register('scm.pullRequest', (params) =>
      this.host.withReview(params, async (review) => {
        const summary = await review.summary()
        if (!summary.ok) return summary
        if (this.host.deps.hosting) {
          const status = await review.status()
          if (!status.ok) return status
          const listed = await this.host.deps.hosting.list(
            status.value.remotes,
            undefined,
            summary.value.branch ?? undefined,
          )
          if (!listed.ok) return listed
          const pr = summary.value.branch
            ? listed.value.requests.find((request) => request.head === summary.value.branch)
            : null
          return ok(
            pr
              ? {
                  number: pr.number,
                  title: pr.title,
                  url: pr.url,
                  state: pr.state,
                  isDraft: pr.draft,
                }
              : null,
          )
        }
        return ok(
          await currentPullRequest(review.cwd, summary.value.branch, {
            ...(params.refresh ? { refresh: true } : {}),
          }),
        )
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
    void this.unwatch(id)
    const subscription: Subscription = {
      ...(scope.data.sessionId ? { sessionId: scope.data.sessionId } : {}),
    }
    this.#subscriptions.set(id, subscription)
    subscription.pending = this.host
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

  async unwatch(id: string): Promise<void> {
    const subscription = this.#subscriptions.get(id)
    this.#subscriptions.delete(id)
    const watched = subscription?.watched
    if (!watched) return
    watched.ids.delete(id)
    if (watched.ids.size) return
    this.#watched.delete(subscription.key!)
    await watched.task
      .then(async (result) => {
        if (result.ok) await result.value()
      })
      .catch((error: unknown) => log.warn('Git watch cleanup failed', { error: String(error) }))
  }

  /** Cancels pending subscriptions and awaits Git handles on a released workspace. */
  async dropSession(sessionId: string, roots: readonly string[]): Promise<void> {
    const targets = roots.map((root) => keyFor(resolve(root)))
    for (const [id, subscription] of [...this.#subscriptions]) {
      if (subscription.sessionId === sessionId) {
        await this.unwatch(id)
        continue
      }
      await subscription.pending
      const key = subscription.key
      if (key && targets.some((root) => key === root || key.startsWith(root + sep)))
        await this.unwatch(id)
    }
  }

  /** Releases subscriptions even when watcher startup is still pending. */
  close(): void {
    this.#closed = true
    for (const id of this.#subscriptions.keys()) void this.unwatch(id)
  }
}
