import { randomUUID } from 'node:crypto'
import type {
  ChangeRequest,
  ChangeRequestAction,
  HostConnection,
  SourceControlConnect,
  SourceControlConnection,
  SourceControlError,
  SourceControlRepository,
} from '@ari/contracts/rpc'
import { sourceControlSchemas } from '@ari/contracts/rpc'
import { err, ok, type Result } from '@ari/shared/result'
import type { GitReviewService } from '@ari/engine/git'
import { HostingError } from './hosting-api'
import type { HostingApi } from './hosting-api'
import { chooseHost } from './host-remote'
import {
  encodePath,
  isBitbucketCloud,
  listPath,
  record,
  requestItems,
  requestPath,
  str,
  toRequest,
} from './hosting-models'
import { normalizeInstance } from './source-control-connections'
import { gitCafeDiff } from './hosting-diff'

/** One provider boundary for discovery, requests, review and publication. */
export class HostingService {
  constructor(readonly api: HostingApi) {}

  host(remotes: readonly { name: string; url: string }[]): SourceControlRepository | null {
    const host = chooseHost(remotes, this.api.connections.list())
    if (!host) return null
    const { provider, instance, name, remote, url } = host
    return { provider, instance, name, remote, url }
  }

  async connect(
    input: SourceControlConnect,
  ): Promise<Result<SourceControlConnection, SourceControlError>> {
    return this.#result(async () => {
      const instance = normalizeInstance(input.instance)
      if (
        input.provider === 'gitcafe' &&
        !['https://git.cafe', 'https://staging.git.cafe'].includes(instance)
      )
        throw new HostingError(
          'unsupported',
          'GitCafe connections use git.cafe or staging.git.cafe.',
        )
      if (!input.token && !['github', 'gitlab'].includes(input.provider))
        throw new HostingError('unauthenticated', 'Enter an access token to connect this provider.')
      if (input.provider === 'azure-devops' && instance === 'https://dev.azure.com')
        throw new HostingError(
          'failed',
          'Include your organization in the instance URL, for example https://dev.azure.com/your-organization.',
        )
      const host = { provider: input.provider, instance }
      const path =
        input.provider === 'gitcafe'
          ? '/auth/principal'
          : input.provider === 'azure-devops'
            ? '/_apis/connectionData?api-version=7.1'
            : input.provider === 'bitbucket' && instance !== 'https://bitbucket.org'
              ? '/application-properties'
              : '/user'
      let account: string | null = null
      try {
        const row = record(await this.api.request(host, path, { credential: input }))
        account =
          str(row.login) ||
          str(row.username) ||
          str(row.handle) ||
          str(row.display_name) ||
          str(record(row.authenticatedUser).providerDisplayName) ||
          input.username ||
          null
      } catch (error) {
        // Repository/workspace access tokens need not have permission to read a Cloud user's profile.
        if (
          input.provider !== 'bitbucket' ||
          !(error instanceof HostingError) ||
          error.status !== 403
        )
          throw error
      }
      return this.api.connections.save({ ...input, instance }, account)
    })
  }

  async list(
    remotes: readonly { name: string; url: string }[],
    signal?: AbortSignal,
    branch?: string,
  ): Promise<Result<HostConnection, SourceControlError>> {
    const host = this.host(remotes)
    if (!host)
      return ok({
        repository: null,
        requests: [],
        detail: remotes.length
          ? 'This repository’s remote is not recognized. For a self-hosted service, add its instance in Settings → Source control.'
          : 'This repository has no Git remote. Add a remote for its hosted repository to load pull or merge requests.',
      })
    const result = await this.#result(async () =>
      requestItems(host, await this.api.request(host, listPath(host, branch), { signal })),
    )
    if (!result.ok) return result
    const requests = branch
      ? result.value.filter((request) => request.head === branch && !request.headIsFork)
      : result.value
    return ok({
      repository: host,
      requests,
      detail: requests.length
        ? `${requests.length} open ${host.provider === 'gitlab' ? 'merge' : 'pull'} request${requests.length === 1 ? '' : 's'}.`
        : `No open ${host.provider === 'gitlab' ? 'merge' : 'pull'} requests.`,
    })
  }

  async detail(
    host: SourceControlRepository,
    number: number,
    signal?: AbortSignal,
  ): Promise<Result<ChangeRequest, SourceControlError>> {
    return this.#result(async () =>
      toRequest(
        host,
        await this.api.request(
          host,
          `${requestPath(host, number)}${host.provider === 'azure-devops' ? '?api-version=7.1' : ''}`,
          { signal },
        ),
      ),
    )
  }

  async create(
    review: GitReviewService,
    draft: boolean,
    signal?: AbortSignal,
  ): Promise<Result<string, SourceControlError>> {
    return this.#result(async () => {
      const status = await review.status(signal)
      if (!status.ok)
        throw new HostingError(
          status.error.code === 'unavailable' ? 'unavailable' : 'failed',
          status.error.message,
        )
      const host = this.host(status.value.remotes)
      if (!host || !status.value.branch)
        throw new HostingError(
          'unsupported',
          'Connect this hosting instance and check out a branch before opening a request.',
        )
      const existing = await this.list(status.value.remotes, signal, status.value.branch)
      if (!existing.ok)
        throw new HostingError(
          existing.error.code === 'unauthenticated' ? 'unauthenticated' : 'failed',
          existing.error.message,
        )
      if (existing.value.requests[0]) return existing.value.requests[0].url
      const remoteHead = await review.git.run(
        ['symbolic-ref', '--quiet', `refs/remotes/${host.remote}/HEAD`],
        { signal },
      )
      let base = remoteHead.ok
        ? remoteHead.value.trim().replace(`refs/remotes/${host.remote}/`, '')
        : ''
      if (!base) {
        const refs = await review.refs(signal)
        if (refs.ok)
          base =
            ['main', 'master', 'trunk', 'develop'].find(
              (name) => refs.value.includes(`${host.remote}/${name}`) || refs.value.includes(name),
            ) ?? ''
      }
      if (!base || base === status.value.branch)
        throw new HostingError(
          'failed',
          'Create a feature branch and configure the remote default branch before opening a request.',
        )
      const message = await review.git.run(['log', '-1', '--format=%s%n%n%b'], { signal })
      const [subject = status.value.branch, ...lines] = message.ok
        ? message.value.trim().split('\n')
        : []
      const title =
        draft && host.provider === 'gitlab'
          ? `Draft: ${subject}`
          : draft && host.provider === 'forgejo'
            ? `[WIP] ${subject}`
            : subject
      const body = lines.join('\n').trim()
      const head = status.value.branch
      let payload: unknown
      switch (host.provider) {
        case 'github':
        case 'forgejo':
          payload = { title, body, head, base, draft }
          break
        case 'gitlab':
          payload = { title, description: body, source_branch: head, target_branch: base }
          break
        case 'bitbucket':
          payload = isBitbucketCloud(host)
            ? {
                title,
                description: body,
                source: { branch: { name: head } },
                destination: { branch: { name: base } },
              }
            : {
                title,
                description: body,
                fromRef: {
                  id: `refs/heads/${head}`,
                  repository: {
                    slug: host.name.split('/')[1],
                    project: { key: host.name.split('/')[0] },
                  },
                },
                toRef: { id: `refs/heads/${base}` },
              }
          break
        case 'azure-devops':
          payload = {
            title,
            description: body,
            sourceRefName: `refs/heads/${head}`,
            targetRefName: `refs/heads/${base}`,
            isDraft: draft,
          }
          break
        case 'gitcafe': {
          const repo = record(
            await this.api.request(host, `/repos/${encodePath(host.name)}`, { signal }),
          )
          if (!str(repo.id))
            throw new HostingError('failed', 'Could not read the GitCafe repository identity.')
          payload = { repo: repo.id, source: head, target: base, title, description: body }
          break
        }
        default:
          throw new HostingError('unsupported', 'Request creation is unavailable for this remote.')
      }
      const response = await this.api.request(
        host,
        `${requestPath(host)}${host.provider === 'azure-devops' ? '?api-version=7.1' : ''}`,
        { method: 'POST', body: payload, signal },
      )
      if (host.provider === 'gitcafe') {
        const id = record(response).number
        if (typeof id !== 'number')
          throw new HostingError('failed', 'The host did not confirm the created request.')
        if (draft)
          await this.api.request(host, `${requestPath(host, id)}/draft`, {
            method: 'POST',
            body: {
              expectedVersion: record(
                await this.api.request(host, requestPath(host, id), { signal }),
              ).version,
            },
            signal,
          })
        return `${host.url}/pulls/${id}`
      }
      return toRequest(host, response).url
    })
  }

  async diff(
    host: SourceControlRepository,
    number: number,
    review: GitReviewService,
    signal?: AbortSignal,
  ): Promise<Result<string, SourceControlError>> {
    return this.#result(async () => {
      const path = requestPath(host, number)
      if (host.provider === 'gitcafe') return gitCafeDiff(this.api, host, number, signal)
      if (host.provider === 'github' || host.provider === 'forgejo') {
        const patch = await this.api.request(
          host,
          host.provider === 'forgejo' ? `${path}.diff` : path,
          { raw: true, signal },
        )
        if (typeof patch !== 'string')
          throw new HostingError('failed', 'Could not read the request diff.')
        return patch
      }
      if (host.provider === 'bitbucket' && isBitbucketCloud(host)) {
        const patch = await this.api.request(host, `${path}/diff`, { raw: true, signal })
        if (typeof patch !== 'string')
          throw new HostingError('failed', 'Could not read the request diff.')
        return patch
      }
      if (host.provider === 'gitlab') {
        const rows: unknown[] = []
        // Do not silently omit files beyond GitLab's first page or its diff limits.
        for (let page = 1; ; page++) {
          const batch = await this.api.request(host, `${path}/diffs?per_page=100&page=${page}`, {
            signal,
          })
          if (!Array.isArray(batch))
            throw new HostingError('failed', 'Could not read the merge request diff.')
          rows.push(...(batch as unknown[]))
          if (batch.length < 100) break
          if (page >= 10)
            throw new HostingError(
              'failed',
              'This request exceeds the 1,000-file review limit. Open it on GitLab to review all changes.',
            )
        }
        const metadata = record(await this.api.request(host, path, { signal }))
        const count = str(metadata.changes_count)
        if (count.endsWith('+') || (/^\d+$/.test(count) && Number(count) > rows.length))
          throw new HostingError(
            'failed',
            'GitLab omitted files from this diff. Open the request on GitLab to review all changes.',
          )
        const patch = rows
          .map((value) => {
            const row = record(value)
            const old = str(row.old_path),
              next = str(row.new_path)
            if (row.too_large === true || row.collapsed === true || !str(row.diff))
              throw new HostingError(
                'failed',
                'GitLab omitted a binary, collapsed or oversized diff. Open this request on GitLab to review all changes.',
              )
            // Quote path headers so spaces and Unicode follow Git's patch spelling.
            return `diff --git ${JSON.stringify(`a/${old}`)} ${JSON.stringify(`b/${next}`)}\n--- ${row.new_file === true ? '/dev/null' : JSON.stringify(`a/${old}`)}\n+++ ${row.deleted_file === true ? '/dev/null' : JSON.stringify(`b/${next}`)}\n${str(row.diff)}`
          })
          .join('\n')
        if (Buffer.byteLength(patch) > 8 * 1024 * 1024)
          throw new HostingError(
            'failed',
            'The request diff is too large to display. Open it on GitLab.',
          )
        return patch
      }
      const request = await this.detail(host, number, signal)
      if (!request.ok) throw new HostingError('failed', request.error.message)
      if (
        !request.value.headOid ||
        !sourceControlSchemas.revision.safeParse(request.value.base).success
      )
        throw new HostingError('failed', 'The host has not reported a valid request head and base.')
      const prefix = `refs/ari/request-review/${host.provider}/${number}/${randomUUID()}`
      try {
        const fetched = await review.git.run(
          [
            'fetch',
            '--no-tags',
            host.remote,
            `+refs/heads/${request.value.base}:${prefix}/base`,
            `+${request.value.headOid}:${prefix}/head`,
          ],
          { signal, timeoutMs: 60_000 },
        )
        if (!fetched.ok)
          throw new HostingError(
            'failed',
            'Could not fetch the request revisions. Check Git authentication or open the request on the host.',
          )
        const patch = await review.git.run(
          ['diff', '--no-ext-diff', '--no-textconv', `${prefix}/base...${prefix}/head`, '--'],
          { signal },
        )
        if (!patch.ok) throw new HostingError('failed', patch.error.message)
        return patch.value
      } finally {
        await review.git.run(['update-ref', '--stdin'], {
          input: `delete ${prefix}/base\ndelete ${prefix}/head\n`,
          timeoutMs: 10_000,
        })
      }
    })
  }

  async act(
    host: SourceControlRepository,
    number: number,
    action: ChangeRequestAction,
    signal?: AbortSignal,
  ): Promise<Result<{ message: string }, SourceControlError>> {
    return this.#result(async () => {
      const path = requestPath(host, number)
      const fresh = record(
        await this.api.request(
          host,
          `${path}${host.provider === 'azure-devops' ? '?api-version=7.1' : ''}`,
          { signal },
        ),
      )
      const request = toRequest(host, fresh)
      const caps = request.capabilities
      if (request.state !== 'open')
        throw new HostingError(
          'failed',
          'This request is no longer open. Refresh to see its current state.',
        )
      if (
        (action.kind === 'merge' && (!caps.merge.includes(action.method) || request.draft)) ||
        (action.kind === 'close' && !caps.close) ||
        (action.kind === 'ready' && !caps.draft) ||
        (action.kind === 'comment' && !caps.comments) ||
        (action.kind === 'approve' && !caps.review.includes('approve')) ||
        (action.kind === 'request-changes' && !caps.review.includes('request-changes'))
      )
        throw new HostingError('unsupported', 'This action is unavailable for this request.')
      if (action.kind === 'merge' && request.headOid !== action.headOid)
        throw new HostingError(
          'failed',
          'The request changed since you reviewed it. Refresh the diff before merging.',
        )
      let endpoint = path,
        method = 'POST',
        body: unknown
      switch (host.provider) {
        case 'github':
        case 'forgejo': {
          if (action.kind === 'comment') {
            endpoint = `/repos/${encodePath(host.name)}/issues/${number}/comments`
            body = { body: action.text }
          } else if (action.kind === 'approve' || action.kind === 'request-changes') {
            endpoint = `${path}/reviews`
            body = {
              body: action.text,
              event:
                action.kind === 'approve'
                  ? host.provider === 'forgejo'
                    ? 'APPROVED'
                    : 'APPROVE'
                  : 'REQUEST_CHANGES',
              commit_id: request.headOid,
            }
          } else if (action.kind === 'close') {
            method = 'PATCH'
            body = { state: 'closed' }
          } else if (action.kind === 'ready') {
            if (host.provider === 'github') {
              const id = fresh.node_id
              endpoint = '/graphql'
              body = {
                query:
                  'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
                variables: { id },
              }
            } else {
              method = 'PATCH'
              body = {
                title: request.title.replace(/^(?:\[WIP\]|WIP:|Draft:)\s*/i, ''),
                draft: false,
              }
            }
          } else if (action.kind === 'merge') {
            endpoint = `${path}/merge`
            method = host.provider === 'github' ? 'PUT' : 'POST'
            body =
              host.provider === 'github'
                ? { merge_method: action.method, sha: action.headOid }
                : { Do: action.method, head_commit_id: action.headOid }
          }
          break
        }
        case 'gitlab': {
          if (action.kind === 'comment') {
            endpoint = `${path}/notes`
            body = { body: action.text }
          } else if (action.kind === 'approve') {
            endpoint = `${path}/approve`
            body = { sha: request.headOid }
          } else if (action.kind === 'merge') {
            endpoint = `${path}/merge`
            method = 'PUT'
            body = { sha: action.headOid, squash: action.method === 'squash' }
          } else {
            method = 'PUT'
            body =
              action.kind === 'close'
                ? { state_event: 'close' }
                : { title: request.title.replace(/^(?:Draft:|WIP:)\s*/i, '') }
          }
          break
        }
        case 'bitbucket': {
          if (action.kind === 'comment') {
            endpoint = `${path}/comments`
            body = isBitbucketCloud(host)
              ? { content: { raw: action.text } }
              : { text: action.text }
          } else if (action.kind === 'approve') {
            endpoint = `${path}/approve`
          } else if (action.kind === 'close') {
            endpoint = `${path}/decline${isBitbucketCloud(host) ? '' : `?version=${String(fresh.version)}`}`
          } else if (action.kind === 'merge') {
            endpoint = `${path}/merge${isBitbucketCloud(host) ? '' : `?version=${String(fresh.version)}`}`
            body = isBitbucketCloud(host)
              ? {
                  merge_strategy: action.method === 'squash' ? 'squash' : 'merge_commit',
                  close_source_branch: false,
                }
              : { strategyId: action.method === 'squash' ? 'squash' : 'no-ff' }
          }
          break
        }
        case 'azure-devops': {
          if (action.kind === 'comment') {
            endpoint = `${path}/threads?api-version=7.1`
            body = {
              comments: [{ parentCommentId: 0, content: action.text, commentType: 1 }],
              status: 1,
            }
          } else {
            endpoint = `${path}?api-version=7.1`
            method = 'PATCH'
            body =
              action.kind === 'close'
                ? { status: 'abandoned' }
                : action.kind === 'ready'
                  ? { isDraft: false }
                  : action.kind === 'merge'
                    ? {
                        status: 'completed',
                        lastMergeSourceCommit: { commitId: action.headOid },
                        completionOptions: {
                          mergeStrategy:
                            action.method === 'squash'
                              ? 'squash'
                              : action.method === 'rebase'
                                ? 'rebase'
                                : 'noFastForward',
                          deleteSourceBranch: false,
                        },
                      }
                    : undefined
          }
          break
        }
        case 'gitcafe': {
          if (action.kind === 'comment') {
            endpoint = `${path}/comments/`
            body = { body: action.text }
          } else if (action.kind === 'approve' || action.kind === 'request-changes') {
            endpoint = `${path}/reviews`
            body = {
              verdict: action.kind === 'approve' ? 'approve' : 'request_changes',
              body: action.text,
              commitOid: request.headOid,
              expectedVersion: fresh.version,
              requestId: randomUUID(),
            }
          } else if (action.kind === 'merge') {
            const base =
              fresh.mergeRoute === 'provider'
                ? str(fresh.observedBaseOid)
                : str(
                    record(
                      await this.api.request(
                        host,
                        `/repos/${encodePath(host.name)}/commit?ref=${encodeURIComponent(`refs/heads/${request.base}`)}`,
                        { signal },
                      ),
                    ).oid,
                  )
            if (!sourceControlSchemas.oid.safeParse(base).success)
              throw new HostingError(
                'failed',
                'The host has not reported the target revision. Refresh and retry.',
              )
            endpoint = `${path}/merge`
            body = {
              requestId: randomUUID(),
              expectedVersion: fresh.version,
              headOid: action.headOid,
              baseOid: base,
              strategy: action.method,
            }
          } else {
            endpoint = `${path}/${action.kind}`
            body = { expectedVersion: fresh.version }
          }
          break
        }
      }
      const response = record(await this.api.request(host, endpoint, { method, body, signal }))
      if (Array.isArray(response.errors) && response.errors.length)
        throw new HostingError(
          'failed',
          'The host rejected the request action. Check permissions and retry.',
        )
      if (action.kind === 'merge' && (response.merged === false || response.state === 'failed'))
        throw new HostingError(
          'failed',
          'The host could not merge this request. Check conflicts and required checks on the host.',
        )
      if (
        action.kind === 'approve' &&
        action.text.trim() &&
        (host.provider === 'gitlab' || host.provider === 'bitbucket')
      ) {
        try {
          await this.api.request(
            host,
            `${path}/${host.provider === 'gitlab' ? 'notes' : 'comments'}`,
            {
              method: 'POST',
              body:
                host.provider === 'gitlab'
                  ? { body: action.text }
                  : isBitbucketCloud(host)
                    ? { content: { raw: action.text } }
                    : { text: action.text },
              signal,
            },
          )
        } catch {
          throw new HostingError(
            'failed',
            'Approval submitted, but the accompanying comment could not be posted. Your text is kept; post it as a comment or open the host.',
          )
        }
      }
      return {
        message:
          action.kind === 'merge'
            ? 'Merge submitted. Refresh to check the result.'
            : action.kind === 'close'
              ? 'Request closed.'
              : action.kind === 'ready'
                ? 'Request marked ready for review.'
                : action.kind === 'approve'
                  ? 'Approval submitted.'
                  : action.kind === 'request-changes'
                    ? 'Changes requested.'
                    : 'Comment posted.',
      }
    })
  }

  async #result<T>(run: () => Promise<T>): Promise<Result<T, SourceControlError>> {
    try {
      return ok(await run())
    } catch (error) {
      return err(
        error instanceof HostingError
          ? { code: error.code, message: error.message }
          : {
              code: 'failed',
              message:
                'The hosting response could not be validated. Refresh or open the request on the host.',
            },
      )
    }
  }
}
