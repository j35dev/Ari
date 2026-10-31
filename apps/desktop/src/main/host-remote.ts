import type { SourceControlProvider, SourceControlRepository } from '@ari/contracts/rpc'

export interface ClassifiedHost extends SourceControlRepository {
  /** Ari can list open requests for this host through its CLI. */
  listable: boolean
  label: string
}

interface Parts {
  host: string
  path: string
}

function parts(raw: string): Parts | null {
  const stripped = raw.trim().replace(/(https?:\/\/|ssh:\/\/)[^/@\s]+@/g, '$1')
  const scp = /^(?:[^@\s]+@)?([^:\s]+):([^\\]+)$/.exec(stripped)
  if (scp?.[1] && scp[2] && !stripped.includes('://')) {
    return { host: scp[1].toLowerCase(), path: scp[2] }
  }
  try {
    const url = new URL(stripped)
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null
    return { host: url.hostname.toLowerCase(), path: decodeURIComponent(url.pathname) }
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
    .replace(/\.git$/i, '')
    .split('/')
    .filter((segment) => segment.length > 0)
  if (provider === 'azure-devops') {
    const marker = segments.indexOf('_git')
    if (marker >= 0) segments = [...segments.slice(0, marker), ...segments.slice(marker + 1)]
    if (segments[0] === 'v3') segments = segments.slice(1)
  } else if (provider === 'github' || provider === 'bitbucket' || provider === 'forgejo') {
    segments = segments.slice(0, 2)
  }
  if (segments.length < 2 || segments.some((segment) => segment === '.' || segment === '..'))
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
        ? `https://${instanceHost}/${project}/_git/${repo}`
        : `https://dev.azure.com/${org}/${project}/_git/${repo}`
    }
  }
  return `https://${instanceHost}/${name}`
}

/** Classifies a configured Git remote without contacting the host. */
export function classifyRemote(remote: string, rawUrl: string): ClassifiedHost | null {
  const parsed = parts(rawUrl)
  if (!parsed) return null
  const matched = forge(parsed.host)
  if (!matched) return null
  const parsedName = repoName(matched.provider, parsed.path)
  const org = matched.instanceHost.endsWith('.visualstudio.com')
    ? matched.instanceHost.slice(0, -'.visualstudio.com'.length)
    : ''
  const name =
    parsedName && org && !parsedName.startsWith(`${org}/`) ? `${org}/${parsedName}` : parsedName
  if (!name) return null
  return {
    provider: matched.provider,
    instance: `https://${matched.instanceHost}`,
    name,
    remote,
    url: repositoryUrl(matched.provider, matched.instanceHost, name),
    listable: matched.listable,
    label: matched.label,
  }
}

/** Prefers origin, then the first remote Ari recognizes. */
export function chooseHost(
  remotes: readonly { name: string; url: string }[],
): ClassifiedHost | null {
  const found = remotes.flatMap((remote) => {
    const classified = classifyRemote(remote.name, remote.url)
    return classified ? [classified] : []
  })
  return found.find((remote) => remote.remote === 'origin') ?? found[0] ?? null
}
