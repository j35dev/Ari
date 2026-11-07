import type {
  SourceControlConnection,
  SourceControlProvider,
  SourceControlRepository,
} from '@ari/contracts/rpc'

export interface ClassifiedHost extends SourceControlRepository {
  /** An adapter can list requests once this instance is authenticated. */
  listable: boolean
  label: string
}

interface Parts {
  host: string
  path: string
  authority?: string
  ssh?: boolean
}

function parts(raw: string): Parts | null {
  const stripped = raw.trim().replace(/(https?:\/\/|ssh:\/\/)[^/@\s]+@/g, '$1')
  const scp = /^(?:[^@\s]+@)?([^:\s]+):([^\\]+)$/.exec(stripped)
  if (scp?.[1] && scp[2] && !stripped.includes('://')) {
    return { host: scp[1].toLowerCase(), path: scp[2], ssh: true }
  }
  try {
    const url = new URL(stripped)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
    return {
      host: url.hostname.toLowerCase(),
      authority: url.host.toLowerCase(),
      path: decodeURIComponent(url.pathname),
      ssh: url.protocol === 'ssh:',
    }
  } catch {
    return null
  }
}

function forge(host: string): {
  provider: SourceControlProvider
  label: string
  listable: boolean
  instanceHost: string
} | null {
  const bare = host.replace(/^www\./, '')
  if (bare === 'github.com')
    return { provider: 'github', label: 'GitHub', listable: true, instanceHost: 'github.com' }
  if (bare.endsWith('.ghe.com') && bare.length > '.ghe.com'.length)
    return {
      provider: 'github',
      label: 'GitHub Enterprise Cloud',
      listable: true,
      instanceHost: bare,
    }
  if (bare === 'gitlab.com')
    return { provider: 'gitlab', label: 'GitLab', listable: true, instanceHost: 'gitlab.com' }
  if (bare === 'codeberg.org')
    return { provider: 'forgejo', label: 'Codeberg', listable: false, instanceHost: bare }
  if (bare === 'gitea.com')
    return { provider: 'forgejo', label: 'Gitea', listable: false, instanceHost: bare }
  if (bare === 'git.cafe' || bare === 'staging.git.cafe')
    return { provider: 'gitcafe', label: 'GitCafe', listable: true, instanceHost: bare }
  if (bare === 'bitbucket.org')
    return { provider: 'bitbucket', label: 'Bitbucket Cloud', listable: false, instanceHost: bare }
  if (bare === 'dev.azure.com' || bare === 'ssh.dev.azure.com')
    return {
      provider: 'azure-devops',
      label: 'Azure DevOps',
      listable: false,
      instanceHost: 'dev.azure.com',
    }
  if (bare.endsWith('.visualstudio.com') && bare.length > '.visualstudio.com'.length)
    return {
      provider: 'azure-devops',
      label: 'Azure DevOps',
      listable: false,
      instanceHost: bare,
    }
  return null
}

function repoName(provider: SourceControlProvider, path: string): string | null {
  let segments = path
    .replace(/\.git\/*$/i, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  if (provider === 'azure-devops') {
    const marker = segments.indexOf('_git')
    if (marker >= 0) segments = [...segments.slice(0, marker), ...segments.slice(marker + 1)]
    if (segments[0] === 'v3') segments = segments.slice(1)
  } else if (provider !== 'gitlab') {
    if (provider === 'bitbucket' && segments[0] === 'scm') segments = segments.slice(1)
    if (segments.length !== 2) return null
  }
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..'))
    return null
  if (
    segments.some(
      (segment) =>
        /[?#\\]/.test(segment) ||
        [...segment].some(
          (character) => character.charCodeAt(0) < (provider === 'azure-devops' ? 32 : 33),
        ),
    )
  )
    return null
  return segments.join('/')
}

function repositoryUrl(
  provider: SourceControlProvider,
  instanceHost: string,
  name: string,
): string {
  if (provider === 'azure-devops') {
    const [org, project, repo, extra] = name.split('/')
    if (org && project && repo && extra === undefined) {
      return instanceHost.endsWith('.visualstudio.com')
        ? `https://${instanceHost}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`
        : `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`
    }
  }
  return `https://${instanceHost}/${name}`
}

/** Classifies a configured Git remote without contacting the host. */
export function classifyRemote(
  remote: string,
  rawUrl: string,
  connections: readonly SourceControlConnection[] = [],
): ClassifiedHost | null {
  const parsed = parts(rawUrl)
  if (!parsed) return null
  parsed.path = `/${parsed.path.replace(/^\/+/, '')}`
  if (parsed.host === 'ssh.dev.azure.com' || parsed.host === 'vs-ssh.visualstudio.com') {
    const azure = /^\/v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(parsed.path)
    if (!azure) return null
    parsed.host =
      parsed.host === 'ssh.dev.azure.com' ? 'dev.azure.com' : `${azure[1]}.visualstudio.com`
    parsed.authority = parsed.host
    parsed.path =
      parsed.host === 'dev.azure.com'
        ? `/${azure[1]}/${azure[2]}/_git/${azure[3]}`
        : `/${azure[2]}/_git/${azure[3]}`
  }
  const matching = connections.filter((entry) => {
    const url = new URL(entry.instance)
    const prefix = decodeURIComponent(url.pathname).replace(/\/$/, '')
    const authority = parsed.ssh
      ? url.hostname.toLowerCase() === parsed.host
      : url.host.toLowerCase() === (parsed.authority ?? parsed.host)
    return authority && (!prefix || parsed.path.startsWith(`${prefix}/`))
  })
  const connection = matching.sort(
    (a, b) => new URL(b.instance).pathname.length - new URL(a.instance).pathname.length,
  )[0]
  if (
    parsed.ssh &&
    connection &&
    matching[1] &&
    new URL(connection.instance).pathname.length === new URL(matching[1].instance).pathname.length
  )
    return null
  const matched = connection
    ? {
        provider: connection.provider,
        label: connection.provider === 'forgejo' ? 'Forgejo / Gitea' : connection.provider,
        listable: true,
        instanceHost: new URL(connection.instance).host,
      }
    : forge(parsed.host)
  if (!matched) return null
  const prefix = connection
    ? decodeURIComponent(new URL(connection.instance).pathname).replace(/\/$/, '')
    : ''
  const parsedName = repoName(
    matched.provider,
    prefix ? parsed.path.slice(prefix.length) : parsed.path,
  )
  const org = matched.instanceHost.endsWith('.visualstudio.com')
    ? matched.instanceHost.slice(0, -'.visualstudio.com'.length)
    : ''
  const name =
    parsedName && org && !parsedName.startsWith(`${org}/`) ? `${org}/${parsedName}` : parsedName
  if (!name) return null
  return {
    provider: matched.provider,
    instance: connection?.instance ?? `https://${matched.instanceHost}`,
    name,
    remote,
    url:
      matched.provider === 'azure-devops' && connection && prefix
        ? `${connection.instance}/${parsedName!.split('/').slice(0, -1).map(encodeURIComponent).join('/')}/_git/${encodeURIComponent(parsedName!.split('/').at(-1)!)}`
        : matched.provider === 'bitbucket' && matched.instanceHost !== 'bitbucket.org'
          ? `${connection?.instance ?? `https://${matched.instanceHost}`}/projects/${name.split('/')[0]}/repos/${name.split('/')[1]}`
          : prefix && matched.provider !== 'azure-devops'
            ? `${connection!.instance}/${name}`
            : repositoryUrl(matched.provider, matched.instanceHost, name),
    listable: matched.listable,
    label: matched.label,
  }
}

/** Prefers origin, then the first remote Ari recognizes. */
export function chooseHost(
  remotes: readonly { name: string; url: string }[],
  connections: readonly SourceControlConnection[] = [],
): ClassifiedHost | null {
  const found = remotes.flatMap((remote) => {
    const classified = classifyRemote(remote.name, remote.url, connections)
    return classified ? [classified] : []
  })
  return found.find((remote) => remote.remote === 'origin') ?? found[0] ?? null
}
