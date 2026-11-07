// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlProvider } from '@ari/contracts/rpc'
import { GitReviewService } from '@ari/engine/git'
import { SourceControlConnections } from './source-control-connections'
import { aesGcmSecretBox } from './secret-box'
import { apiBase, HostingApi } from './hosting-api'
import { HostingService } from './hosting-service'
import { record, requestPath, toRequest } from './hosting-models'

let dir: string
let store: SourceControlConnections
const box = aesGcmSecretBox(randomBytes(32))
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-hosting-'))
  store = new SourceControlConnections(join(dir, 'connections.json'), box)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
const oid = 'a'.repeat(40)
const github = {
  number: 4,
  title: 'Review this',
  body: 'Description',
  state: 'open',
  head: { ref: 'feature', sha: oid },
  base: { ref: 'main' },
  user: { login: 'sam' },
  updated_at: '2026-11-06T00:00:00Z',
}
const fixtures: {
  provider: SourceControlProvider
  instance: string
  remote: string
  route: string
  payload: unknown
}[] = [
  {
    provider: 'github',
    instance: 'https://github.com',
    remote: 'git@github.com:team/demo.git',
    route: 'https://api.github.com/repos/team/demo/pulls?',
    payload: [github],
  },
  {
    provider: 'gitlab',
    instance: 'https://git.company.test',
    remote: 'git@git.company.test:team/sub/demo.git',
    route: 'https://git.company.test/api/v4/projects/team%2Fsub%2Fdemo/merge_requests?',
    payload: [
      {
        iid: 4,
        title: 'Review this',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        sha: oid,
        author: { username: 'sam' },
        updated_at: '2026-11-06',
      },
    ],
  },
  {
    provider: 'forgejo',
    instance: 'https://codeberg.org',
    remote: 'https://codeberg.org/team/demo.git',
    route: 'https://codeberg.org/api/v1/repos/team/demo/pulls?',
    payload: [github],
  },
  {
    provider: 'bitbucket',
    instance: 'https://bitbucket.org',
    remote: 'git@bitbucket.org:team/demo.git',
    route: 'https://api.bitbucket.org/2.0/repositories/team/demo/pullrequests?',
    payload: {
      values: [
        {
          id: 4,
          title: 'Review this',
          state: 'OPEN',
          source: { branch: { name: 'feature' }, commit: { hash: oid } },
          destination: { branch: { name: 'main' } },
          author: { display_name: 'sam' },
          updated_on: '2026-11-06',
        },
      ],
    },
  },
  {
    provider: 'bitbucket',
    instance: 'https://git.company.test',
    remote: 'https://git.company.test/scm/TEAM/demo.git',
    route: 'https://git.company.test/rest/api/1.0/projects/TEAM/repos/demo/pull-requests?',
    payload: {
      values: [
        {
          id: 4,
          title: 'Review this',
          state: 'OPEN',
          fromRef: { displayId: 'feature', latestCommit: oid },
          toRef: { displayId: 'main' },
          author: { name: 'sam' },
          updatedDate: 100,
          version: 2,
        },
      ],
    },
  },
  {
    provider: 'azure-devops',
    instance: 'https://dev.azure.com/team',
    remote: 'git@ssh.dev.azure.com:v3/team/project/demo',
    route: 'https://dev.azure.com/team/project/_apis/git/repositories/demo/pullrequests?',
    payload: {
      value: [
        {
          pullRequestId: 4,
          title: 'Review this',
          status: 'active',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          lastMergeSourceCommit: { commitId: oid },
          createdBy: { displayName: 'sam' },
          creationDate: '2026-11-06',
        },
      ],
    },
  },
  {
    provider: 'gitcafe',
    instance: 'https://git.cafe',
    remote: 'ssh@git.cafe:team/demo.git',
    route: 'https://git.cafe/api/repos/team/demo/pulls?',
    payload: {
      items: [
        {
          number: 4,
          title: 'Review this',
          state: 'open',
          sourceBranch: 'feature',
          targetBranch: 'main',
          headOid: oid,
          author: { handle: 'sam' },
          updatedAt: '2026-11-06',
          version: 1,
        },
      ],
      next: null,
    },
  },
]

describe('hosting provider boundary', () => {
  it.each([
    { remotes: [], detail: 'no Git remote' },
    {
      remotes: [{ name: 'origin', url: 'https://private.test/team/demo.git' }],
      detail: 'remote is not recognized',
    },
  ])(
    'explains an unidentified remote without treating it as a GitHub login failure',
    async ({ remotes, detail }) => {
      const run = vi.fn()
      const fetcher = vi.fn<typeof fetch>()
      const service = new HostingService(new HostingApi(store, run, fetcher))
      expect(await service.list(remotes)).toMatchObject({
        ok: true,
        value: { repository: null, requests: [], detail: expect.stringContaining(detail) },
      })
      expect(run).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(fixtures)(
    'lists and normalizes $provider on $instance',
    async ({ provider, instance, remote, route, payload }) => {
      store.save({ provider, instance, username: '', token: 'test-secret' }, 'sam')
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload)))
      const service = new HostingService(new HostingApi(store, vi.fn(), fetcher))
      const result = await service.list([{ name: 'origin', url: remote }])
      expect(result).toMatchObject({
        ok: true,
        value: {
          requests: [
            { number: 4, title: 'Review this', head: 'feature', base: 'main', headOid: oid },
          ],
        },
      })
      expect(String(fetcher.mock.calls[0]?.[0])).toContain(route)
      expect(JSON.stringify(result)).not.toContain('test-secret')
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error')
    },
  )

  it('encrypts persisted tokens, reopens them, and scopes credentials to the exact instance', async () => {
    store.save(
      { provider: 'forgejo', instance: 'https://forge.test', username: '', token: 'test-secret' },
      'sam',
    )
    expect(await readFile(join(dir, 'connections.json'), 'utf8')).not.toContain('test-secret')
    const reopened = new SourceControlConnections(join(dir, 'connections.json'), box)
    expect(reopened.credential('https://forge.test')).toMatchObject({ token: 'test-secret' })
    expect(reopened.credential('https://another.test')).toBeNull()
    expect(JSON.stringify(reopened.list())).not.toContain('test-secret')
    expect(reopened.remove(reopened.list()[0]!.id)).toBe(true)
    expect(reopened.list()).toEqual([])
  })

  it('uses the signed-in GitHub CLI without passing credentials or a repository guessed from cwd', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([github]) })
    const service = new HostingService(new HostingApi(store, run))
    expect(
      await service.list([{ name: 'origin', url: 'git@github.com:team/demo.git' }]),
    ).toMatchObject({ ok: true })
    expect(run.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '--hostname',
        'github.com',
        'repos/team/demo/pulls?state=open&per_page=30&limit=30',
      ]),
    )
  })

  it('refuses a moved head before sending a merge, and reports host rejection', async () => {
    store.save(
      { provider: 'github', instance: 'https://github.com', username: '', token: 'test-secret' },
      'sam',
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (_url, options) =>
          new Response(JSON.stringify(options?.method === 'PUT' ? { merged: false } : github)),
      )
    const service = new HostingService(new HostingApi(store, vi.fn(), fetcher))
    const host = service.host([{ name: 'origin', url: 'https://github.com/team/demo.git' }])!
    expect(
      await service.act(host, 4, { kind: 'merge', method: 'squash', headOid: 'b'.repeat(40) }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('changed since') } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(
      await service.act(host, 4, { kind: 'merge', method: 'squash', headOid: oid }),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining('could not merge') } })
  })

  it('reports authentication, rate limits and invalid payloads as errors rather than empty lists', async () => {
    store.save(
      { provider: 'forgejo', instance: 'https://codeberg.org', username: '', token: 'test-secret' },
      'sam',
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}'))
    const service = new HostingService(new HostingApi(store, vi.fn(), fetcher))
    const remotes = [{ name: 'origin', url: 'https://codeberg.org/team/demo.git' }]
    for (const code of ['unauthenticated', 'rate-limited', 'failed'])
      expect(await service.list(remotes)).toMatchObject({ ok: false, error: { code } })
  })

  it('preserves Azure legacy and collection routes', () => {
    store.save(
      {
        provider: 'azure-devops',
        instance: 'https://team.visualstudio.com/DefaultCollection',
        username: '',
        token: 'test-secret',
      },
      'sam',
    )
    const service = new HostingService(new HostingApi(store))
    const host = service.host([
      { name: 'origin', url: 'https://team.visualstudio.com/DefaultCollection/project/_git/demo' },
    ])!
    expect(requestPath(host)).toBe('/project/_apis/git/repositories/demo/pullrequests')
    expect(host.url).toBe('https://team.visualstudio.com/DefaultCollection/project/_git/demo')
  })

  it.each(fixtures)(
    'creates a request using the $provider API',
    async ({ provider, instance, remote, payload }) => {
      store.save({ provider, instance, username: '', token: 'test-secret' }, 'sam')
      const wrapper = record(payload)
      const response = (
        Array.isArray(payload) ? payload : (wrapper.values ?? wrapper.value ?? wrapper.items)
      ) as unknown[]
      const api = new HostingApi(store)
      const request = vi.spyOn(api, 'request').mockImplementation(async (_host, path, options) => {
        if (options?.method === 'POST') return response[0]
        if (path.includes('?state=') || path.includes('?searchCriteria'))
          return provider === 'bitbucket'
            ? { values: [] }
            : provider === 'azure-devops'
              ? { value: [] }
              : provider === 'gitcafe'
                ? { items: [] }
                : []
        return { id: 'repo-identity' }
      })
      const review = {
        status: async () => ({
          ok: true,
          value: { branch: 'feature', remotes: [{ name: 'origin', url: remote }] },
        }),
        git: {
          run: vi
            .fn()
            .mockResolvedValueOnce({ ok: true, value: 'refs/remotes/origin/main\n' })
            .mockResolvedValueOnce({ ok: true, value: 'Add review\n\nA description' }),
        },
      } as unknown as GitReviewService
      const result = await new HostingService(api).create(review, false)
      expect(result).toMatchObject({ ok: true, value: expect.stringMatching(/^https:\/\//) })
      expect(
        request.mock.calls.find(([, , options]) => options?.method === 'POST')?.[2]?.body,
      ).toMatchObject({ title: 'Add review' })
    },
  )

  it.each(fixtures)(
    'posts comments using the $provider API',
    async ({ provider, instance, remote, payload }) => {
      store.save({ provider, instance, username: '', token: 'test-secret' }, 'sam')
      const wrapper = record(payload)
      const rows = (
        Array.isArray(payload) ? payload : (wrapper.values ?? wrapper.value ?? wrapper.items)
      ) as unknown[]
      const api = new HostingApi(store)
      const request = vi
        .spyOn(api, 'request')
        .mockResolvedValueOnce(rows[0])
        .mockResolvedValueOnce({})
      const service = new HostingService(api)
      expect(
        await service.act(service.host([{ name: 'origin', url: remote }])!, 4, {
          kind: 'comment',
          text: 'Reviewed the changes.',
        }),
      ).toMatchObject({ ok: true })
      expect(request.mock.calls[1]?.[1]).toContain(
        provider === 'gitlab' ? '/notes' : provider === 'azure-devops' ? '/threads' : '/comments',
      )
      expect(JSON.stringify(request.mock.calls[1]?.[2]?.body)).toContain('Reviewed the changes.')
    },
  )

  it('uses the Enterprise Cloud API and preserves Azure names with spaces', () => {
    expect(apiBase({ provider: 'github', instance: 'https://team.ghe.com' })).toBe(
      'https://api.team.ghe.com',
    )
    store.save(
      {
        provider: 'azure-devops',
        instance: 'https://dev.azure.com/team',
        username: '',
        token: 'test-secret',
      },
      'sam',
    )
    const host = new HostingService(new HostingApi(store)).host([
      { name: 'origin', url: 'https://dev.azure.com/team/My%20Project/_git/My%20Repo' },
    ])!
    expect(requestPath(host)).toBe('/My%20Project/_apis/git/repositories/My%20Repo/pullrequests')
  })

  it('honors GitCafe permissions and Forgejo title-based drafts', async () => {
    const api = new HostingApi(store)
    const service = new HostingService(api)
    const cafe = service.host([{ name: 'origin', url: 'https://git.cafe/team/demo.git' }])!
    const row = {
      number: 4,
      title: 'Review',
      state: 'open',
      sourceBranch: 'feature',
      targetBranch: 'main',
      headOid: oid,
      capabilities: { comment: false, review: false, merge: false, edit: false, moderate: false },
    }
    expect(toRequest(cafe, row).capabilities).toMatchObject({
      comments: false,
      review: [],
      merge: [],
      close: false,
      draft: false,
    })
    const call = vi.spyOn(api, 'request').mockResolvedValue(row)
    expect(
      await service.act(cafe, 4, { kind: 'merge', headOid: oid, method: 'merge' }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(call).toHaveBeenCalledTimes(1)
    expect(
      toRequest(service.host([{ name: 'origin', url: 'https://codeberg.org/team/demo.git' }])!, {
        ...github,
        title: '[WIP] Add review',
      }).draft,
    ).toBe(true)
  })

  it('does not reuse a same-named branch from a fork', async () => {
    const api = new HostingApi(store)
    vi.spyOn(api, 'request').mockResolvedValue([
      { ...github, head: { ...github.head, repo: { full_name: 'another/demo' } } },
    ])
    const service = new HostingService(api)
    expect(
      await service.list(
        [{ name: 'origin', url: 'https://github.com/team/demo.git' }],
        undefined,
        'feature',
      ),
    ).toMatchObject({ ok: true, value: { requests: [] } })
  })

  it('pages GitLab diffs and reports omitted content', async () => {
    const api = new HostingApi(store)
    const service = new HostingService(api)
    store.save(
      { provider: 'gitlab', instance: 'https://gitlab.com', username: '', token: 'test-secret' },
      'sam',
    )
    const host = service.host([{ name: 'origin', url: 'https://gitlab.com/team/demo.git' }])!
    const row = { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-before\n+after\n' }
    const request = vi
      .spyOn(api, 'request')
      .mockResolvedValue({})
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => row))
      .mockResolvedValueOnce([row])
    expect(await service.diff(host, 4, {} as GitReviewService)).toMatchObject({ ok: true })
    expect(request.mock.calls[1]?.[1]).toContain('page=2')
    request.mockResolvedValueOnce([{ ...row, too_large: true }])
    expect(await service.diff(host, 4, {} as GitReviewService)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('omitted') },
    })
    request.mockResolvedValueOnce([row]).mockResolvedValueOnce({ changes_count: '1000+' })
    expect(await service.diff(host, 4, {} as GitReviewService)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('omitted files') },
    })
  })

  it('retains an honest partial result when an approval comment fails', async () => {
    store.save(
      { provider: 'gitlab', instance: 'https://gitlab.com', username: '', token: 'test-secret' },
      'sam',
    )
    const api = new HostingApi(store)
    vi.spyOn(api, 'request')
      .mockResolvedValueOnce({
        iid: 4,
        title: 'Review',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        sha: oid,
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('offline'))
    const service = new HostingService(api)
    expect(
      await service.act(
        service.host([{ name: 'origin', url: 'https://gitlab.com/team/demo.git' }])!,
        4,
        { kind: 'approve', text: 'Looks good.' },
      ),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Approval submitted, but') },
    })
  })

  it('uses plain text for forge diffs and detects exhausted 403 rate limits', async () => {
    store.save(
      { provider: 'forgejo', instance: 'https://codeberg.org', username: '', token: 'test-secret' },
      'sam',
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('patch'))
      .mockResolvedValueOnce(
        new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      )
    const api = new HostingApi(store, vi.fn(), fetcher)
    const host = { provider: 'forgejo' as const, instance: 'https://codeberg.org' }
    expect(await api.request(host, '/repos/team/demo/pulls/4.diff', { raw: true })).toBe('patch')
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ Accept: 'text/plain' })
    await expect(api.request(host, '/user')).rejects.toMatchObject({ code: 'rate-limited' })
  })

  it('follows bounded Bitbucket diff redirects without forwarding credentials off the API origin', async () => {
    store.save(
      {
        provider: 'bitbucket',
        instance: 'https://bitbucket.org',
        username: '',
        token: 'test-secret',
      },
      'sam',
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://api.bitbucket.org/2.0/repositories/team/demo/diff/abc' },
        }),
      )
      .mockResolvedValueOnce(new Response('patch'))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://another.test/steal' } }),
      )
    const api = new HostingApi(store, vi.fn(), fetcher)
    const host = { provider: 'bitbucket' as const, instance: 'https://bitbucket.org' }
    expect(
      await api.request(host, '/repositories/team/demo/pullrequests/4/diff', { raw: true }),
    ).toBe('patch')
    await expect(
      api.request(host, '/repositories/team/demo/pullrequests/4/diff', { raw: true }),
    ).rejects.toThrow('untrusted')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('pins GitCafe diff pages and hunks to one request version', async () => {
    const api = new HostingApi(store)
    const service = new HostingService(api)
    const host = service.host([{ name: 'origin', url: 'https://git.cafe/team/demo.git' }])!
    const revision = { version: 2, headOid: oid, comparisonBaseOid: 'b'.repeat(40) }
    const file = { path: 'a.ts', status: 'modified' }
    const call = vi
      .spyOn(api, 'request')
      .mockResolvedValueOnce({ version: 2, headOid: oid })
      .mockResolvedValueOnce({ ...revision, items: [file], next: null })
      .mockResolvedValueOnce({
        ...revision,
        items: [
          {
            ...file,
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { origin: '-', content: 'before\n' },
                  { origin: '+', content: 'after\n' },
                ],
              },
            ],
          },
        ],
      })
    expect(await service.diff(host, 4, {} as GitReviewService)).toMatchObject({
      ok: true,
      value: expect.stringContaining('-before\n+after'),
    })
    call
      .mockResolvedValueOnce({ version: 2, headOid: oid })
      .mockResolvedValueOnce({ ...revision, version: 3, items: [file], next: null })
    expect(await service.diff(host, 4, {} as GitReviewService)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('changed while') },
    })
  })

  it('uses Forgejo approval events and binds the review to the request head', async () => {
    const api = new HostingApi(store)
    const service = new HostingService(api)
    const host = service.host([{ name: 'origin', url: 'https://codeberg.org/team/demo.git' }])!
    const call = vi.spyOn(api, 'request').mockResolvedValueOnce(github).mockResolvedValueOnce({})
    expect(await service.act(host, 4, { kind: 'approve', text: 'Reviewed.' })).toMatchObject({
      ok: true,
    })
    expect(call.mock.calls[1]?.[2]?.body).toMatchObject({ event: 'APPROVED', commit_id: oid })
  })

  it('fetches a real request diff without moving HEAD or leaving shared review refs', async () => {
    const cwd = join(dir, 'repo')
    await mkdir(cwd)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.test')
    git('config', 'user.name', 'Test')
    await writeFile(join(cwd, 'a.ts'), 'before\n')
    git('add', '.')
    git('commit', '-m', 'Base')
    git('switch', '-c', 'feature')
    await writeFile(join(cwd, 'a.ts'), 'after\n')
    git('add', '.')
    git('commit', '-m', 'Request')
    const head = git('rev-parse', 'HEAD')
    git('remote', 'add', 'origin', cwd)
    const api = new HostingApi(store)
    const service = new HostingService(api)
    vi.spyOn(api, 'request').mockResolvedValue({
      pullRequestId: 4,
      title: 'Review',
      status: 'active',
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      lastMergeSourceCommit: { commitId: head },
    })
    const host = service.host([
      { name: 'origin', url: 'https://dev.azure.com/team/project/_git/demo' },
    ])!
    expect(await service.diff(host, 4, new GitReviewService(cwd))).toMatchObject({
      ok: true,
      value: expect.stringContaining('-before\n+after'),
    })
    expect(git('rev-parse', 'HEAD')).toBe(head)
    expect(git('for-each-ref', '--format=%(refname)', 'refs/ari/request-review')).toBe('')
  })
})
