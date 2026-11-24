import { TRIAGE_REPOSITORY, type TriageMatch, type TriageDraft } from '@ari/contracts/triage'
import { record, str } from '../hosting-models'
import type { HostingApi } from '../hosting-api'

const host = { provider: 'github' as const, instance: 'https://github.com' }
const repoPath = `/repos/${TRIAGE_REPOSITORY}`
export function caseMarker(id: string): string {
  return `<!-- ari-triage:${id} -->`
}
export class TriageGitHub {
  constructor(readonly api: HostingApi) {}
  async identity(): Promise<string> {
    const account = str(record(await this.api.request(host, '/user')).login)
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(account))
      throw new Error('Sign in to GitHub in Source control settings before publishing.')
    return account
  }
  async search(query: string): Promise<TriageMatch[]> {
    const terms = query
      .replace(/[^\p{L}\p{N} _.-]/gu, ' ')
      .trim()
      .slice(0, 200)
    const path = `/search/issues?q=${encodeURIComponent(`repo:${TRIAGE_REPOSITORY} ${terms}`)}&per_page=20`
    let payload: unknown
    try {
      payload = await this.api.request(host, path)
    } catch {
      const response = await fetch(`https://api.github.com${path}`, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
      if (!response.ok)
        throw new Error(
          `GitHub search is unavailable (HTTP ${response.status}). You can still draft a report.`,
        )
      payload = (await response.json()) as unknown
    }
    const items = record(payload).items
    if (!Array.isArray(items)) return []
    return items.flatMap((item) => {
      const row = record(item),
        url = str(row.html_url)
      if (
        !url.startsWith(`https://github.com/${TRIAGE_REPOSITORY}/`) ||
        typeof row.number !== 'number'
      )
        return []
      return [
        {
          number: row.number,
          title: str(row.title),
          url,
          state: str(row.state),
          kind: row.pull_request ? ('pr' as const) : ('issue' as const),
        },
      ]
    })
  }
  publication(payload: unknown): { number: number; url: string } {
    const row = record(payload),
      url = str(row.html_url)
    if (
      typeof row.number !== 'number' ||
      row.number < 1 ||
      !url.startsWith(`https://github.com/${TRIAGE_REPOSITORY}/`)
    )
      throw new Error(
        'GitHub did not return a valid publication. Check the repository before retrying.',
      )
    return { number: row.number, url }
  }
  async findIssue(id: string): Promise<{ number: number; url: string } | null> {
    for (let page = 1; page <= 5; page++) {
      const payload = await this.api.request(
        host,
        `${repoPath}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      )
      if (!Array.isArray(payload)) throw new Error('GitHub issue reconciliation failed.')
      const item: unknown = payload.find(
        (item) => !record(item).pull_request && str(record(item).body).includes(caseMarker(id)),
      )
      if (item) return this.publication(item)
      if (payload.length < 100) break
    }
    return null
  }
  async createIssue(id: string, draft: TriageDraft): Promise<{ number: number; url: string }> {
    return this.publication(
      await this.api.request(host, `${repoPath}/issues`, {
        method: 'POST',
        body: { title: draft.title, body: `${draft.body}\n\n${caseMarker(id)}` },
      }),
    )
  }
  async findPr(
    id: string,
    account: string,
    branch: string,
  ): Promise<{ number: number; url: string } | null> {
    const payload = await this.api.request(
      host,
      `${repoPath}/pulls?state=all&head=${encodeURIComponent(`${account}:${branch}`)}&per_page=100`,
    )
    if (!Array.isArray(payload)) throw new Error('GitHub PR reconciliation failed.')
    const item: unknown = payload.find((item) => str(record(item).body).includes(caseMarker(id)))
    return item ? this.publication(item) : null
  }
  async fork(account: string): Promise<string> {
    const path = `/repos/${account}/Ari`
    let payload: unknown
    try {
      payload = await this.api.request(host, path)
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('status' in error) ||
        error.status !== 404
      )
        throw error
      payload = await this.api.request(host, `${repoPath}/forks`, {
        method: 'POST',
        body: { default_branch_only: true },
      })
    }
    const row = record(payload)
    if (
      str(row.full_name) !== `${account}/Ari` ||
      str(record(row.parent).full_name) !== TRIAGE_REPOSITORY
    )
      throw new Error(
        'Your Ari repository is not a fork of j35dev/Ari. Choose a valid fork before publishing.',
      )
    return path
  }
  /** Git objects preserve binary bytes and modes. No Git credential is put in argv or files. */
  async createPr(input: {
    id: string
    account: string
    branch: string
    base: string
    draft: TriageDraft
    files: { path: string; mode: string; content: Buffer | null }[]
    expectedTree: string
    commit: string | null
    onCommit: (sha: string) => Promise<void>
  }): Promise<{ number: number; url: string }> {
    const fork = input.account === 'j35dev' ? repoPath : await this.fork(input.account)
    let sha = input.commit
    if (!sha) {
      const base = record(await this.api.request(host, `${fork}/git/commits/${input.base}`))
      const baseTree = str(record(base.tree).sha)
      if (!/^[a-f0-9]{40}$/.test(baseTree))
        throw new Error(
          'Your fork is still preparing or does not contain the fix base. Sync the fork and retry.',
        )
      const tree: { path: string; mode: string; type: string; sha: string | null }[] = []
      let bytes = 0
      for (const file of input.files) {
        bytes += file.content?.length ?? 0
        if (bytes > 20 * 1024 * 1024) throw new Error('The fix exceeds the triage upload limit.')
        const blob =
          file.content === null
            ? null
            : record(
                await this.api.request(host, `${fork}/git/blobs`, {
                  method: 'POST',
                  body: { content: file.content.toString('base64'), encoding: 'base64' },
                }),
              )
        const sha = blob ? str(blob.sha) : null
        if (blob && !/^[a-f0-9]{40}$/.test(sha ?? ''))
          throw new Error('GitHub did not acknowledge a file upload.')
        tree.push({ path: file.path, mode: file.mode, type: 'blob', sha })
      }
      const createdTree = record(
        await this.api.request(host, `${fork}/git/trees`, {
          method: 'POST',
          body: { base_tree: baseTree, tree },
        }),
      )
      if (str(createdTree.sha) !== input.expectedTree)
        throw new Error(
          'The uploaded source tree does not match the verified changes. No branch or PR was published.',
        )
      const commit = record(
        await this.api.request(host, `${fork}/git/commits`, {
          method: 'POST',
          body: { message: input.draft.title, tree: str(createdTree.sha), parents: [input.base] },
        }),
      )
      sha = str(commit.sha)
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('GitHub did not acknowledge the fix commit.')
      await input.onCommit(sha)
    }
    const refPath = `${fork}/git/ref/heads/${input.branch.split('/').map(encodeURIComponent).join('/')}`
    let ref: unknown = null
    try {
      ref = await this.api.request(host, refPath)
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('status' in error) ||
        error.status !== 404
      )
        throw error
    }
    if (ref) {
      if (str(record(record(ref).object).sha) !== sha)
        throw new Error(
          'The publication branch already contains different work. It has been preserved.',
        )
    } else {
      await this.api.request(host, `${fork}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${input.branch}`, sha },
      })
    }
    const existing = await this.findPr(input.id, input.account, input.branch)
    if (existing) return existing
    return this.publication(
      await this.api.request(host, `${repoPath}/pulls`, {
        method: 'POST',
        body: {
          title: input.draft.title,
          body: `${input.draft.body}\n\n${caseMarker(input.id)}`,
          head: `${input.account}:${input.branch}`,
          base: 'main',
          draft: true,
        },
      }),
    )
  }
}
