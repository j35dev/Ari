import { existsSync, lstatSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accountEnvironment,
  defaultAccountHome,
  prepareAccountHome,
  removeAccountHome,
  supportsAccounts,
} from './account-home'
import type { DetectEnvironment } from './types'

let dir: string
let env: DetectEnvironment
/** The default account's home: what the user already has. */
let base: string
/** Where Ari keeps every extra account. */
let root: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-accounts-'))
  env = { platform: process.platform, pathEnv: '', homeDir: join(dir, 'user') }
  base = join(dir, 'user', '.claude')
  root = join(dir, 'accounts')
  home = join(root, 'claude', 'work')
  await mkdir(join(base, 'projects', 'C--repo'), { recursive: true })
  await mkdir(join(base, 'skills'), { recursive: true })
  await writeFile(join(base, 'projects', 'C--repo', 'session-1.jsonl'), 'conversation')
  await writeFile(join(base, 'settings.json'), '{"model":"opus"}')
  await writeFile(join(base, '.credentials.json'), 'the default account sign-in')
  await writeFile(join(base, '.claude.json'), '{"oauthAccount":"default"}')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('prepareAccountHome', () => {
  it('shares conversations and settings, and nothing that says who is signed in', async () => {
    const report = await prepareAccountHome('claude', home, env)

    expect(readFileSync(join(home, 'projects', 'C--repo', 'session-1.jsonl'), 'utf8')).toBe(
      'conversation',
    )
    expect(lstatSync(join(home, 'projects')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{"model":"opus"}')
    expect(existsSync(join(home, '.credentials.json'))).toBe(false)
    expect(existsSync(join(home, '.claude.json'))).toBe(false)
    expect(report.linked).toEqual(expect.arrayContaining(['projects', 'skills']))
    // Folders the default home does not have yet are not invented.
    expect(existsSync(join(home, 'agents'))).toBe(false)
  })

  it('lets a conversation written by one account be read by the other', async () => {
    await prepareAccountHome('claude', home, env)
    await writeFile(join(home, 'projects', 'C--repo', 'session-2.jsonl'), 'from the work account')
    expect(readFileSync(join(base, 'projects', 'C--repo', 'session-2.jsonl'), 'utf8')).toBe(
      'from the work account',
    )
  })

  it('picks up what the default home gains later and is harmless to repeat', async () => {
    await prepareAccountHome('claude', home, env)
    await mkdir(join(base, 'agents'))
    await writeFile(join(base, 'agents', 'reviewer.md'), 'agent')

    const again = await prepareAccountHome('claude', home, env)
    expect(readFileSync(join(home, 'agents', 'reviewer.md'), 'utf8')).toBe('agent')
    expect(again.skipped).toEqual([])
    expect((await readdir(join(base, 'projects', 'C--repo'))).sort()).toEqual(['session-1.jsonl'])
  })

  it('replaces an empty folder the CLI made but leaves one with content alone', async () => {
    await mkdir(join(home, 'skills'), { recursive: true })
    await mkdir(join(home, 'projects', 'own'), { recursive: true })
    await writeFile(join(home, 'projects', 'own', 'kept.jsonl'), 'mine')

    const report = await prepareAccountHome('claude', home, env)
    expect(lstatSync(join(home, 'skills')).isSymbolicLink()).toBe(true)
    expect(report.skipped).toEqual([
      { entry: 'projects', reason: 'the account already has its own, with content' },
    ])
    expect(readFileSync(join(home, 'projects', 'own', 'kept.jsonl'), 'utf8')).toBe('mine')
  })

  describe('where files cannot be linked and are copied instead', () => {
    const copy = (): string => join(home, 'settings.json')
    const source = (): string => join(base, 'settings.json')

    /** Leaves the account home as Ari would after copying the file in at some earlier time. */
    async function copiedEarlier(): Promise<void> {
      await mkdir(home, { recursive: true })
      await writeFile(copy(), '{"model":"opus"}')
      const then = new Date(Date.now() - 120_000)
      await utimes(copy(), then, then)
      await utimes(source(), then, then)
      await writeFile(
        join(home, '.ari-shared.json'),
        JSON.stringify({
          'settings.json': { copy: statSync(copy()).mtimeMs, source: statSync(source()).mtimeMs },
        }),
      )
    }

    it('follows a change in the default home while the copy is untouched', async () => {
      await copiedEarlier()
      expect((await prepareAccountHome('claude', home, env)).copied).toEqual([])

      await writeFile(source(), '{"model":"sonnet"}')
      const report = await prepareAccountHome('claude', home, env)
      expect(readFileSync(copy(), 'utf8')).toBe('{"model":"sonnet"}')
      expect(report.copied).toEqual(['settings.json'])
      // And it knows the new copy is its own, so the next change follows too.
      await writeFile(source(), '{"model":"haiku"}')
      const later = new Date(Date.now() + 120_000)
      await utimes(source(), later, later)
      await prepareAccountHome('claude', home, env)
      expect(readFileSync(copy(), 'utf8')).toBe('{"model":"haiku"}')
    })

    it('never overwrites an edit made while running as the account', async () => {
      await copiedEarlier()
      await writeFile(copy(), '{"model":"opus","allow":["Bash(git status)"]}')
      await writeFile(source(), '{"model":"sonnet"}')

      const report = await prepareAccountHome('claude', home, env)
      expect(readFileSync(copy(), 'utf8')).toBe('{"model":"opus","allow":["Bash(git status)"]}')
      expect(report.skipped).toContainEqual({
        entry: 'settings.json',
        reason: 'changed in this account since it was copied',
      })
    })

    it('leaves a file it did not put there', async () => {
      await mkdir(home, { recursive: true })
      await writeFile(copy(), '{"model":"mine"}')
      await prepareAccountHome('claude', home, env)
      expect(readFileSync(copy(), 'utf8')).toBe('{"model":"mine"}')
    })
  })

  it('shares what a dotfile manager has linked into the default home', async () => {
    const dotfiles = join(dir, 'dotfiles', 'claude-commands')
    await mkdir(dotfiles, { recursive: true })
    await writeFile(join(dotfiles, 'ship.md'), 'command')
    symlinkSync(dotfiles, join(base, 'commands'), process.platform === 'win32' ? 'junction' : 'dir')

    const report = await prepareAccountHome('claude', home, env)
    expect(report.linked).toContain('commands')
    expect(readFileSync(join(home, 'commands', 'ship.md'), 'utf8')).toBe('command')
  })

  it('reports an entry it cannot share and still shares the rest', async () => {
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'skills'), 'not a folder')

    const report = await prepareAccountHome('claude', home, env)
    expect(report.skipped).toEqual([{ entry: 'skills', reason: 'a file is in the way' }])
    expect(report.linked).toContain('projects')
    expect(existsSync(join(home, 'projects', 'C--repo', 'session-1.jsonl'))).toBe(true)
  })

  it('makes sure Codex has one conversations folder before the account can make its own', async () => {
    const codexBase = join(dir, 'user', '.codex')
    await mkdir(codexBase, { recursive: true })
    await writeFile(join(codexBase, 'auth.json'), 'default codex sign-in')
    await writeFile(join(codexBase, 'config.toml'), 'model = "gpt-5"')
    const codexHome = join(root, 'codex', 'work')

    const report = await prepareAccountHome('codex', codexHome, env)

    expect(lstatSync(join(codexHome, 'sessions')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(codexBase, 'sessions'))).toBe(true)
    expect(report.linked).toContain('sessions')
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5"')
    expect(existsSync(join(codexHome, 'auth.json'))).toBe(false)
  })

  it('refuses to treat the default home as an account home', async () => {
    await expect(prepareAccountHome('claude', base, env)).rejects.toThrow(/default home/)
  })

  it('does nothing for a provider whose sign-in cannot be relocated', async () => {
    expect(supportsAccounts('opencode')).toBe(false)
    expect(await prepareAccountHome('opencode', home, env)).toEqual({
      linked: [],
      copied: [],
      separate: [],
      skipped: [],
    })
    expect(existsSync(home)).toBe(false)
  })
})

describe('removeAccountHome', () => {
  it('deletes the account and its sign-in without touching what was shared', async () => {
    await prepareAccountHome('claude', home, env)
    await writeFile(join(home, '.credentials.json'), 'the work account sign-in')

    await removeAccountHome(home, root)

    expect(existsSync(home)).toBe(false)
    expect(readFileSync(join(base, 'projects', 'C--repo', 'session-1.jsonl'), 'utf8')).toBe(
      'conversation',
    )
    expect(readFileSync(join(base, 'settings.json'), 'utf8')).toBe('{"model":"opus"}')
    expect(readFileSync(join(base, '.credentials.json'), 'utf8')).toBe('the default account sign-in')
  })

  it('does not follow a link the CLI itself left deeper inside the account', async () => {
    await mkdir(join(home, 'cache'), { recursive: true })
    symlinkSync(
      join(base, 'projects'),
      join(home, 'cache', 'elsewhere'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await removeAccountHome(home, root)

    expect(existsSync(home)).toBe(false)
    expect(existsSync(join(base, 'projects', 'C--repo', 'session-1.jsonl'))).toBe(true)
  })

  it('refuses a path that is not one of its account homes', async () => {
    await expect(removeAccountHome(base, root)).rejects.toThrow(/not under/)
    await expect(removeAccountHome(root, root)).rejects.toThrow(/not under/)
    expect(existsSync(join(base, '.credentials.json'))).toBe(true)
  })

  it('is quiet about an account home that was never created', async () => {
    await expect(removeAccountHome(join(root, 'claude', 'never'), root)).resolves.toBeUndefined()
  })
})

describe('account environment', () => {
  it('points the CLI at the account, and leaves the default account alone', () => {
    expect(accountEnvironment('claude', home)).toEqual({ CLAUDE_CONFIG_DIR: home })
    expect(accountEnvironment('codex', home)).toEqual({ CODEX_HOME: home })
    expect(accountEnvironment('claude', null)).toEqual({})
    expect(accountEnvironment('grok', home)).toEqual({})
  })

  it('takes the default home from the variable when the user already set one', () => {
    expect(defaultAccountHome('claude', env)).toBe(base)
    expect(defaultAccountHome('codex', { ...env, vars: { CODEX_HOME: '/srv/codex' } })).toBe(
      '/srv/codex',
    )
    expect(defaultAccountHome('pi', env)).toBeNull()
  })
})
