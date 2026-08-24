import { describe, expect, it, vi } from 'vitest'
import { createPullRequest } from './gh-pr'

const okRun = (stdout: string) => vi.fn(async () => ({ stdout }))

describe('createPullRequest', () => {
  it('builds the gh argv with title, body, and base', async () => {
    const run = okRun('https://github.com/o/r/pull/7\n')
    const result = await createPullRequest(
      'C:\\repo',
      { title: 'Add feature', body: 'Does things', base: 'main' },
      { run },
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('https://github.com/o/r/pull/7')
    expect(run).toHaveBeenCalledWith(['pr', 'create', '--title', 'Add feature', '--body', 'Does things', '--base', 'main'])
  })

  it('omits body/base when absent and tolerates missing url output', async () => {
    const run = okRun('Creating pull request...\n')
    const result = await createPullRequest('C:\\repo', { title: 'X' }, { run })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('')
    expect(run).toHaveBeenCalledWith(['pr', 'create', '--title', 'X'])
  })

  it('rejects blank titles and dash-leading base refs without running', async () => {
    const run = okRun('')
    const blank = await createPullRequest('C:\\repo', { title: '  ' }, { run })
    const badBase = await createPullRequest('C:\\repo', { title: 'X', base: '-force' }, { run })

    expect(blank.ok).toBe(false)
    expect(badBase.ok).toBe(false)
    if (!badBase.ok) expect(badBase.error.code).toBe('invalid_input')
    expect(run).not.toHaveBeenCalled()
  })

  it('maps a missing gh binary to actionable guidance', async () => {
    const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    const result = await createPullRequest('C:\\repo', { title: 'X' }, {
      run: () => Promise.reject(enoent),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('gh_missing')
      expect(result.error.message).toContain('cli.github.com')
    }
  })

  it('surfaces gh stderr as the failure reason', async () => {
    const result = await createPullRequest('C:\\repo', { title: 'X' }, {
      run: () =>
        Promise.reject(
          Object.assign(new Error('failed'), { stderr: 'GraphQL: already exists\nmore' }),
        ),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('already exists')
  })
})
