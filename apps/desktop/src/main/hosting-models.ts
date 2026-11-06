import { z } from 'zod'
import {
  sourceControlSchemas,
  type ChangeRequest,
  type ChangeRequestCapabilities,
  type SourceControlRepository,
} from '@ari/contracts/rpc'

const object = z.record(z.string(), z.unknown())
export const record = (value: unknown): Record<string, unknown> =>
  object.safeParse(value).data ?? {}
export const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number => (typeof value === 'number' ? value : 0)
const user = (value: unknown): string => {
  const row = record(value)
  return (
    str(row.login) ||
    str(row.username) ||
    str(row.handle) ||
    str(row.display_name) ||
    str(row.displayName) ||
    str(row.name) ||
    'unknown'
  )
}
export const encodePath = (value: string): string =>
  value.split('/').map(encodeURIComponent).join('/')
export const isBitbucketCloud = (host: SourceControlRepository): boolean =>
  host.instance === 'https://bitbucket.org'

export function requestPath(host: SourceControlRepository, id?: number): string {
  const name = encodePath(host.name)
  let path: string
  switch (host.provider) {
    case 'gitlab':
      path = `/projects/${encodeURIComponent(host.name)}/merge_requests`
      break
    case 'bitbucket': {
      const [project, repository] = host.name.split('/')
      path = isBitbucketCloud(host)
        ? `/repositories/${name}/pullrequests`
        : `/projects/${encodeURIComponent(project!)}/repos/${encodeURIComponent(repository!)}/pull-requests`
      break
    }
    case 'azure-devops': {
      const route = decodeURIComponent(new URL(host.url).pathname)
        .slice(decodeURIComponent(new URL(host.instance).pathname).replace(/\/$/, '').length)
        .replace(/^\//, '')
      const parts = route.split('/_git/')
      if (parts.length !== 2 || !parts[1]) throw new Error('Invalid Azure repository route')
      path = `/${encodePath(parts[0]!)}/_apis/git/repositories/${encodeURIComponent(parts[1])}/pullrequests`
      break
    }
    default:
      path = `/repos/${name}/pulls`
  }
  return id === undefined ? path : `${path}/${id}`
}

export function listPath(host: SourceControlRepository, branch?: string): string {
  const path = requestPath(host)
  switch (host.provider) {
    case 'gitlab':
      return `${path}?state=opened&per_page=30${branch ? `&source_branch=${encodeURIComponent(branch)}` : ''}`
    case 'bitbucket':
      return `${path}?${isBitbucketCloud(host) ? 'state=OPEN&pagelen=30' : 'state=OPEN&limit=30'}`
    case 'azure-devops':
      return `${path}?searchCriteria.status=active&$top=30&api-version=7.1`
    case 'gitcafe':
      return `${path}?state=open&limit=30&sort=newest${branch ? `&sourceBranches=${encodeURIComponent(JSON.stringify([branch]))}` : ''}`
    default:
      return `${path}?state=open&per_page=30&limit=30`
  }
}

export function capabilities(host: SourceControlRepository): ChangeRequestCapabilities {
  const full: ChangeRequestCapabilities = {
    diff: true,
    comments: true,
    review: ['comment', 'approve', 'request-changes'],
    inlineReview: false,
    merge: ['merge', 'squash', 'rebase'],
    draft: true,
    close: true,
  }
  switch (host.provider) {
    case 'gitlab':
      return { ...full, review: ['comment', 'approve'], merge: ['merge', 'squash'] }
    case 'bitbucket':
      return { ...full, review: ['comment', 'approve'], merge: ['merge', 'squash'], draft: false }
    case 'azure-devops':
      return { ...full, review: ['comment'], merge: ['merge', 'squash', 'rebase'] }
    case 'gitcafe':
      return full
    default:
      return full
  }
}

/** Normalize at the provider boundary; an invalid host payload must never become a clean empty list. */
export function toRequest(host: SourceControlRepository, value: unknown): ChangeRequest {
  const row = record(value)
  const source = record(row.source)
  const destination = record(row.destination)
  const head = record(row.head)
  const base = record(row.base)
  const from = record(row.fromRef)
  const to = record(row.toRef)
  const links = record(row.links)
  const isGitlab = host.provider === 'gitlab'
  const isCafe = host.provider === 'gitcafe'
  const id = number(row.iid) || number(row.number) || number(row.pullRequestId) || number(row.id)
  const state = str(row.state || row.status).toLowerCase()
  const merged =
    row.merged === true ||
    row.merged_at != null ||
    row.mergedAt != null ||
    state === 'merged' ||
    state === 'completed'
  const updatedAt =
    str(row.updated_at) ||
    str(row.updatedAt) ||
    str(row.updated_on) ||
    str(row.creationDate) ||
    (typeof row.updatedDate === 'number' ? new Date(row.updatedDate).toISOString() : '')
  const title = str(row.title)
  const request: ChangeRequest = {
    repository: host,
    number: id,
    title,
    body: str(row.body) || str(row.description),
    url:
      str(row.html_url) ||
      str(row.web_url) ||
      str(record(links.html).href) ||
      (host.provider === 'azure-devops'
        ? `${host.url}/pullrequest/${id}`
        : host.provider === 'bitbucket'
          ? `${host.url}/${isBitbucketCloud(host) ? 'pull-requests' : 'pull-requests'}/${id}`
          : `${host.url}/${isGitlab ? '-/merge_requests' : isCafe ? 'pulls' : 'pull'}/${id}`),
    author: user(row.author || row.user || row.createdBy),
    state: merged
      ? 'merged'
      : ['closed', 'declined', 'abandoned'].includes(state)
        ? 'closed'
        : 'open',
    draft:
      row.draft === true ||
      row.isDraft === true ||
      row.work_in_progress === true ||
      (host.provider === 'forgejo' && /^(?:\[WIP\]|WIP:|Draft:)\s*/i.test(title)),
    base:
      str(row.target_branch) ||
      str(row.targetBranch) ||
      str(row.targetRefName).replace(/^refs\/heads\//, '') ||
      str(base.ref) ||
      str(record(destination.branch).name) ||
      str(to.displayId),
    head:
      str(row.source_branch) ||
      str(row.sourceBranch) ||
      str(row.sourceRefName).replace(/^refs\/heads\//, '') ||
      str(head.ref) ||
      str(record(source.branch).name) ||
      str(from.displayId),
    headOid: null,
    updatedAt,
    capabilities: capabilities(host),
  }
  const oid =
    str(row.sha) ||
    str(row.headOid) ||
    str(head.sha) ||
    str(record(source.commit).hash) ||
    str(from.latestCommit) ||
    str(record(row.lastMergeSourceCommit).commitId)
  request.headOid = sourceControlSchemas.oid.safeParse(oid).success ? oid : null
  const cafeSource = record(row.sourceRepo)
  const sourceName =
    str(record(head.repo).full_name) ||
    str(record(source.repository).full_name) ||
    (isCafe && str(cafeSource.owner) && str(cafeSource.name)
      ? `${str(cafeSource.owner)}/${str(cafeSource.name)}`
      : '')
  if (sourceName) request.headIsFork = sourceName.toLowerCase() !== host.name.toLowerCase()
  else if (row.source_project_id != null && row.target_project_id != null)
    request.headIsFork = row.source_project_id !== row.target_project_id
  else if (record(from.repository).id != null && record(to.repository).id != null)
    request.headIsFork = record(from.repository).id !== record(to.repository).id
  else if (host.provider === 'azure-devops') request.headIsFork = row.forkSource != null
  if (isCafe && row.capabilities != null) {
    const caps = record(row.capabilities)
    request.capabilities = {
      ...request.capabilities,
      comments: caps.comment === true && (row.lockedAt == null || caps.moderate === true),
      review:
        caps.review === true &&
        (!row.viewerActorId || row.viewerActorId !== record(row.author).actorId)
          ? ['approve', 'request-changes']
          : [],
      merge: caps.merge === true ? request.capabilities.merge : [],
      draft: caps.edit === true,
      close: caps.edit === true,
    }
  }
  const parsed = sourceControlSchemas.changeRequest.safeParse(request)
  if (
    !parsed.success ||
    !title ||
    !request.head ||
    !request.base ||
    ![
      'open',
      'opened',
      'active',
      'closed',
      'declined',
      'abandoned',
      'merged',
      'completed',
    ].includes(state)
  )
    throw new Error('Invalid change request response')
  return parsed.data
}

export function requestItems(host: SourceControlRepository, payload: unknown): ChangeRequest[] {
  const wrapper = record(payload)
  const items = Array.isArray(payload)
    ? payload
    : (wrapper.values ?? wrapper.value ?? wrapper.items)
  if (!Array.isArray(items)) throw new Error('Invalid change request list')
  return items.slice(0, 30).map((row) => toRequest(host, row))
}
