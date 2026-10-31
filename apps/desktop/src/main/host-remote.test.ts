// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chooseHost, classifyRemote } from './host-remote'

describe('classifyRemote', () => {
  it.each([
    ['https://github.com/acme/demo.git', 'github', 'https://github.com', 'acme/demo', true],
    ['git@github.com:acme/demo.git', 'github', 'https://github.com', 'acme/demo', true],
    ['ssh://git@github.com/acme/demo.git', 'github', 'https://github.com', 'acme/demo', true],
    [
      'https://token@acme.ghe.com/acme/demo.git',
      'github',
      'https://acme.ghe.com',
      'acme/demo',
      true,
    ],
    [
      'https://gitlab.com/group/sub/demo.git',
      'gitlab',
      'https://gitlab.com',
      'group/sub/demo',
      true,
    ],
    ['git@gitlab.com:group/demo.git', 'gitlab', 'https://gitlab.com', 'group/demo', true],
    ['https://codeberg.org/acme/demo', 'forgejo', 'https://codeberg.org', 'acme/demo', false],
    ['https://gitea.com/acme/demo.git', 'forgejo', 'https://gitea.com', 'acme/demo', false],
    ['git@bitbucket.org:acme/demo.git', 'bitbucket', 'https://bitbucket.org', 'acme/demo', false],
    [
      'https://dev.azure.com/org/project/_git/demo',
      'azure-devops',
      'https://dev.azure.com',
      'org/project/demo',
      false,
    ],
    [
      'https://org.visualstudio.com/project/_git/demo',
      'azure-devops',
      'https://org.visualstudio.com',
      'org/project/demo',
      false,
    ],
    [
      'git@ssh.dev.azure.com:v3/org/project/demo',
      'azure-devops',
      'https://dev.azure.com',
      'org/project/demo',
      false,
    ],
  ] as const)('%s is %s', (url, provider, instance, name, listable) => {
    expect(classifyRemote('origin', url)).toMatchObject({ provider, instance, name, listable })
  })

  it('does not guess a private host or keep a credential', () => {
    expect(classifyRemote('origin', 'https://git.example.com/acme/demo.git')).toBeNull()
    expect(classifyRemote('origin', 'C:\\repo')).toBeNull()
    expect(classifyRemote('origin', 'https://user:secret@github.com/acme/demo.git')?.url).toBe(
      'https://github.com/acme/demo',
    )
    expect(
      JSON.stringify(classifyRemote('origin', 'https://user:secret@github.com/acme/demo.git')),
    ).not.toContain('secret')
  })

  it('prefers origin over another recognized remote', () => {
    expect(
      chooseHost([
        { name: 'upstream', url: 'https://gitlab.com/other/demo.git' },
        { name: 'origin', url: 'https://github.com/acme/demo.git' },
      ])?.provider,
    ).toBe('github')
    expect(chooseHost([{ name: 'backup', url: '/tmp/repo' }])).toBeNull()
  })
})
