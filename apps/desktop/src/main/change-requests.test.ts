// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { listChangeRequests, type HostCommand } from './change-requests'

const signal = new AbortController().signal
const sha = 'a'.repeat(40)
const github = [{ name: 'origin', url: 'https://github.com/acme/demo.git' }]
const gitlab = [{ name: 'origin', url: 'https://gitlab.com/group/sub/demo.git' }]

function runWith(stdout: string): HostCommand {
  return vi.fn(async () => ({ stdout }))
}

describe('listChangeRequests', () => {
  it('maps an open GitHub pull request and skips a malformed row', async () => {
    const run = runWith(
      JSON.stringify([
        {
          number: 4,
          title: 'Fix the bug',
          body: 'please',
          url: 'https://github.com/acme/demo/pull/4',
          state: 'OPEN',
          isDraft: true,
          author: { login: 'ada' },
          updatedAt: '2026-10-01T00:00:00Z',
          headRefName: 'fix',
          baseRefName: 'main',
          headRefOid: sha,
        },
        { number: 5, title: 'Broken' },
      ]),
    )
    const result = await listChangeRequests('C:\\repo', github, { run, signal })
    expect(result.ok && result.value.detail).toBe('1 open pull request.')
    expect(result.ok && result.value.requests).toMatchObject([
      {
        number: 4,
        title: 'Fix the bug',
        draft: true,
        state: 'open',
        head: 'fix',
        base: 'main',
        headOid: sha,
        capabilities: { diff: false, review: [], merge: [] },
      },
    ])
    expect(run).toHaveBeenCalledWith(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        '30',
        '--json',
        expect.stringContaining('headRefOid'),
      ],
      'C:\\repo',
      signal,
    )
  })

  it('maps a GitLab merge request from glab JSON', async () => {
    const run = runWith(
      JSON.stringify([
        {
          iid: 8,
          title: 'Add a test',
          description: 'coverage',
          web_url: 'https://gitlab.com/group/sub/demo/-/merge_requests/8',
          state: 'opened',
          draft: false,
          author: { username: 'ada' },
          source_branch: 'test',
          target_branch: 'main',
          sha,
          updated_at: '2026-10-02T00:00:00Z',
        },
      ]),
    )
    const result = await listChangeRequests('/repo', gitlab, { run, signal })
    expect(result.ok && result.value.requests[0]).toMatchObject({
      number: 8,
      title: 'Add a test',
      head: 'test',
      base: 'main',
      author: 'ada',
    })
    expect(run).toHaveBeenCalledWith(
      'glab',
      ['mr', 'list', '--output', 'json', '--per-page', '30'],
      '/repo',
      signal,
    )
  })

  it('recognizes Forgejo, Bitbucket, and Azure without calling a CLI', async () => {
    const run = vi.fn<HostCommand>()
    for (const url of [
      'https://codeberg.org/acme/demo',
      'https://bitbucket.org/acme/demo.git',
      'https://dev.azure.com/org/project/_git/demo',
    ]) {
      const result = await listChangeRequests('/repo', [{ name: 'origin', url }], { run, signal })
      expect(result.ok && result.value.requests).toEqual([])
      expect(result.ok && result.value.detail).toContain('not connected')
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a missing CLI and unreadable output without dropping the host', async () => {
    const missing = vi.fn<HostCommand>(async () => {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    })
    const gone = await listChangeRequests('/repo', github, { run: missing, signal })
    expect(gone.ok && gone.value.repository?.provider).toBe('github')
    expect(gone.ok && gone.value.detail).toBe('GitHub CLI (gh) is not installed.')

    const broken = await listChangeRequests('/repo', gitlab, { run: runWith('{'), signal })
    expect(broken.ok && broken.value.detail).toBe('Could not read merge requests.')
    expect(broken.ok && broken.value.repository?.provider).toBe('gitlab')
  })

  it('leaves an unknown remote unclaimed', async () => {
    const run = vi.fn<HostCommand>()
    const result = await listChangeRequests(
      '/repo',
      [{ name: 'origin', url: 'https://git.example.com/acme/demo.git' }],
      { run, signal },
    )
    expect(result).toEqual({
      ok: true,
      value: {
        repository: null,
        requests: [],
        detail: 'No recognized hosting remote. Ari does not guess a private host.',
      },
    })
    expect(run).not.toHaveBeenCalled()
  })
})
