import { describe, expect, it, vi } from 'vitest'
import { listHubItems, viewHubItem } from './github-hub'

const samplePr = {
  number: 12,
  title: 'Restyle settings',
  url: 'https://github.com/j35dev/Ari/pull/12',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'ada' },
  labels: [{ name: 'ui', color: '5319e7' }],
  updatedAt: '2026-09-15T12:00:00Z',
  headRefName: 'fix/ui',
}

describe('listHubItems', () => {
  it('asks gh for open pull requests with a fixed JSON field list', async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify([samplePr]) }))
    const result = await listHubItems('C:\\repo', { kind: 'pr' }, { run })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual([
        {
          kind: 'pr',
          number: 12,
          title: 'Restyle settings',
          url: 'https://github.com/j35dev/Ari/pull/12',
          state: 'OPEN',
          isDraft: false,
          author: 'ada',
          labels: [{ name: 'ui', color: '5319e7' }],
          updatedAt: '2026-09-15T12:00:00Z',
          headRefName: 'fix/ui',
          body: '',
        },
      ])
    }
    expect(run).toHaveBeenCalledWith([
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      'number,title,url,state,isDraft,author,labels,updatedAt,headRefName',
    ])
  })

  it('lists issues and maps a missing author', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          number: 4,
          title: 'Crash on open',
          url: 'https://github.com/j35dev/Ari/issues/4',
          state: 'OPEN',
          updatedAt: '2026-09-15T12:00:00Z',
          author: null,
        },
      ]),
    }))
    const result = await listHubItems(
      'C:\\repo',
      { kind: 'issue', state: 'all', limit: 10 },
      { run },
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value[0]?.author).toBe('unknown')
    expect(run).toHaveBeenCalledWith([
      'issue',
      'list',
      '--state',
      'all',
      '--limit',
      '10',
      '--json',
      'number,title,url,state,author,labels,updatedAt',
    ])
  })

  it('maps a missing gh binary to install guidance', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    const result = await listHubItems(
      'C:\\repo',
      { kind: 'pr' },
      {
        run: () => Promise.reject(enoent),
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('gh_missing')
      expect(result.error.message).toContain('cli.github.com')
    }
  })

  it('rejects an out-of-range limit without running gh', async () => {
    const run = vi.fn(async () => ({ stdout: '[]' }))
    const result = await listHubItems('C:\\repo', { kind: 'pr', limit: 0 }, { run })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_input')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('viewHubItem', () => {
  it('loads one pull request including the body', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        ...samplePr,
        body: 'Does the thing.',
        baseRefName: 'main',
        additions: 12,
        deletions: 3,
      }),
    }))
    const result = await viewHubItem('C:\\repo', { kind: 'pr', number: 12 }, { run })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.body).toBe('Does the thing.')
      expect(result.value.additions).toBe(12)
      expect(result.value.baseRefName).toBe('main')
    }
    expect(run).toHaveBeenCalledWith([
      'pr',
      'view',
      '12',
      '--json',
      'number,title,url,state,isDraft,author,labels,updatedAt,headRefName,body,baseRefName,additions,deletions',
    ])
  })

  it('rejects non-positive numbers without running gh', async () => {
    const run = vi.fn(async () => ({ stdout: '{}' }))
    const result = await viewHubItem('C:\\repo', { kind: 'issue', number: 0 }, { run })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_input')
    expect(run).not.toHaveBeenCalled()
  })
})
