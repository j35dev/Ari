import type { SourceControlProvider } from './source-control'

/** Hosting metadata shared by settings and the Git UI. Git itself works with every remote. */
export const sourceControlProviders: {
  id: SourceControlProvider
  label: string
  description: string
  instance: string
  cli?: string
  tokenHint: string
  tokenUrl: string
}[] = [
  {
    id: 'github',
    label: 'GitHub',
    description: 'GitHub.com and GitHub Enterprise',
    instance: 'https://github.com',
    cli: 'gh',
    tokenHint: 'A token with repository and pull request access, or your existing gh login.',
    tokenUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    description: 'GitLab.com and self-managed instances',
    instance: 'https://gitlab.com',
    cli: 'glab',
    tokenHint: 'A personal access token with api scope, or your existing glab login.',
    tokenUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  },
  {
    id: 'forgejo',
    label: 'Forgejo / Gitea',
    description: 'Codeberg, Gitea and your own forge',
    instance: 'https://codeberg.org',
    tokenHint: 'A token with repository and issue read/write access.',
    tokenUrl: 'https://codeberg.org/user/settings/applications',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    description: 'Bitbucket Cloud and Data Center',
    instance: 'https://bitbucket.org',
    tokenHint: 'Use an access token, or enter your Atlassian email and API token for Cloud.',
    tokenUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  {
    id: 'azure-devops',
    label: 'Azure DevOps',
    description: 'Azure Repos and Azure DevOps Server',
    instance: 'https://dev.azure.com',
    tokenHint: 'A personal access token with Code read & write access.',
    tokenUrl: 'https://dev.azure.com',
  },
  {
    id: 'gitcafe',
    label: 'GitCafe',
    description: 'Repositories on git.cafe',
    instance: 'https://git.cafe',
    tokenHint: 'A GitCafe access token with repository access.',
    tokenUrl: 'https://git.cafe',
  },
]

export function providerLabel(provider: SourceControlProvider | null): string {
  return sourceControlProviders.find((entry) => entry.id === provider)?.label ?? 'Git remote'
}
