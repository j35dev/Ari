// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  accountOf,
  sourceControlEnvironment,
  versionOf,
  type ToolRunner,
} from './source-control-environment'

const fake =
  (answers: Record<string, { output: string; code: number } | null>): ToolRunner =>
  (command, args) =>
    Promise.resolve(answers[`${command} ${args.join(' ')}`] ?? null)

describe('sourceControlEnvironment', () => {
  it('reports versions and the signed-in GitHub account', async () => {
    const env = await sourceControlEnvironment(
      fake({
        'git --version': { output: 'git version 2.47.1.windows.1', code: 0 },
        'gh --version': { output: 'gh version 2.63.2 (2024-12-05)', code: 0 },
        'gh auth status': {
          output: 'github.com\n  ✓ Logged in to github.com account octo (keyring)',
          code: 0,
        },
        'glab --version': null,
      }),
    )
    expect(env.git).toMatchObject({ installed: true, version: '2.47.1' })
    expect(env.github).toMatchObject({ installed: true, version: '2.63.2', account: 'octo' })
    expect(env.gitlab).toMatchObject({ installed: false, account: null })
  })

  it('says how to sign in when the CLI is installed but signed out', async () => {
    const env = await sourceControlEnvironment(
      fake({
        'git --version': { output: 'git version 2.40.0', code: 0 },
        'gh --version': { output: 'gh version 2.60.0', code: 0 },
        'gh auth status': { output: 'You are not logged into any GitHub hosts.', code: 1 },
      }),
    )
    expect(env.github).toMatchObject({ installed: true, account: null })
    expect(env.github.detail).toMatch(/gh auth login/)
  })
})

describe('parsers', () => {
  it('read versions and glab accounts', () => {
    expect(versionOf('glab 1.48.0 (2024-11-01)')).toBe('1.48.0')
    expect(accountOf('✓ Logged in to gitlab.com as jane (/home/jane/.config/glab-cli)')).toBe(
      'jane',
    )
  })
})
