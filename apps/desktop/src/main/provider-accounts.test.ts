// @vitest-environment node
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import type { CliKind, Settings } from '@ari/contracts/settings'
import type { SettingsPatch } from '@ari/engine/settings'
import { ProviderAccounts, accountIdFor } from './provider-accounts'
import type { ProviderAccountsDeps } from './provider-accounts'

let dir: string
let settings: Settings
let changes: [CliKind, string][]
/** Who the fake CLI says each home is signed in as, keyed by its config dir ('' = default). */
let signedIn: Record<string, string>
let built: ProviderAccounts[]

function build(overrides: Partial<ProviderAccountsDeps> = {}): ProviderAccounts {
  const accounts = new ProviderAccounts({
    root: join(dir, 'accounts'),
    settings: () => settings,
    update: async (patch: SettingsPatch) => {
      const providers = { ...settings.providers }
      for (const kind of Object.keys(patch.providers ?? {}) as CliKind[]) {
        providers[kind] = { ...providers[kind], ...patch.providers?.[kind] }
      }
      settings = { ...settings, providers }
      return settings
    },
    detectEnvironment: async () => ({
      platform: process.platform,
      pathEnv: join(dir, 'found-on-path'),
      homeDir: join(dir, 'user'),
    }),
    binaryPath: async () => '/bin/claude',
    busy: async () => false,
    changed: (kind, what) => changes.push([kind, what]),
    identity: async (_kind, _binary, env) => {
      const email = signedIn[env['CLAUDE_CONFIG_DIR'] ?? '']
      return email === undefined
        ? { signedIn: false, email: null, plan: null }
        : { signedIn: true, email, plan: 'max' }
    },
    signOut: async (_kind, _binary, env) => {
      delete signedIn[env['CLAUDE_CONFIG_DIR'] ?? '']
      return true
    },
    signInPollMs: 5,
    ...overrides,
  })
  built.push(accounts)
  return accounts
}

const workHome = (): string => join(dir, 'accounts', 'claude', 'work')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-provider-accounts-'))
  await mkdir(join(dir, 'user', '.claude', 'projects'), { recursive: true })
  await writeFile(join(dir, 'user', '.claude', 'projects', 'kept.jsonl'), 'conversation')
  settings = structuredClone(defaultSettings)
  changes = []
  signedIn = { '': 'me@home.example' }
  built = []
})

afterEach(async () => {
  for (const accounts of built) accounts.close()
  await rm(dir, { recursive: true, force: true })
})

describe('ProviderAccounts', () => {
  it('starts with the default account, which is the CLI’s own sign-in', async () => {
    const accounts = build()
    expect(await accounts.list('claude')).toEqual({
      supported: true,
      accounts: [
        {
          id: 'default',
          label: 'Default',
          isDefault: true,
          active: true,
          identity: { signedIn: true, email: 'me@home.example', plan: 'max' },
        },
      ],
    })
    expect(accounts.env('claude')).toEqual({})
  })

  it('offers no accounts for a provider whose sign-in cannot be moved', async () => {
    const accounts = build()
    expect(await accounts.list('opencode')).toEqual({ supported: false, accounts: [] })
    expect(await accounts.add('ari-core', 'Work')).toEqual({ supported: false, accounts: [] })
    expect(accounts.env('opencode')).toEqual({})
  })

  it('adds an account with a home of its own that shares the conversations', async () => {
    const accounts = build()
    const result = await accounts.add('claude', '  Work  ')

    expect(result.accounts.map((a) => [a.id, a.label, a.active])).toEqual([
      ['default', 'Default', true],
      ['work', 'Work', false],
    ])
    expect(result.accounts[1]?.identity).toEqual({ signedIn: false, email: null, plan: null })
    expect(existsSync(join(workHome(), 'projects', 'kept.jsonl'))).toBe(true)
    // Adding one does not switch to it.
    expect(accounts.env('claude')).toEqual({})
    expect(changes).toEqual([['claude', 'list']])
  })

  it('keeps both of two accounts added at the same moment', async () => {
    const accounts = build()
    await Promise.all([accounts.add('claude', 'Work'), accounts.add('claude', 'Client')])
    expect(settings.providers.claude.accounts.map((a) => a.id).sort()).toEqual(['client', 'work'])
  })

  it('switches the account turns run as, and back', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')

    const switched = await accounts.activate('claude', 'work')
    expect(switched.accounts.find((a) => a.active)?.id).toBe('work')
    expect(accounts.env('claude')).toEqual({ CLAUDE_CONFIG_DIR: workHome() })
    // Codex is a separate provider with its own active account.
    expect(accounts.env('codex')).toEqual({})

    await accounts.activate('claude', 'default')
    expect(accounts.env('claude')).toEqual({})
    expect(changes.filter(([, what]) => what === 'active')).toHaveLength(2)
  })

  it('announces nothing when asked to switch to the account already in use', async () => {
    const accounts = build()
    await accounts.activate('claude', 'default')
    expect(changes).toEqual([])
    expect((await accounts.activate('claude', 'ghost')).error).toBe('That account no longer exists.')
  })

  it('hands back the CLI’s own sign-in for an account, with that account’s home', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')
    expect(await accounts.signIn('claude', 'work')).toEqual({
      title: 'Work sign-in',
      command: '/bin/claude',
      args: ['auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: workHome() },
    })
    expect(await accounts.signIn('claude', 'default')).toMatchObject({ title: 'Default sign-in', env: {} })
    expect(await accounts.signIn('claude', 'ghost')).toBeNull()
    expect(await build({ binaryPath: async () => null }).signIn('claude', 'default')).toBeNull()
  })

  it('announces a sign-in finished in the terminal, without anyone asking', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')
    await accounts.activate('claude', 'work')
    changes = []

    await accounts.signIn('claude', 'work')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(changes).toEqual([])

    signedIn[workHome()] = 'me@work.example'
    await vi.waitFor(() => expect(changes).toEqual([['claude', 'active']]))
    // What it learned is what a view that starts no CLI then shows.
    const brief = await accounts.list('claude', false, true)
    expect(brief.accounts[1]?.identity?.email).toBe('me@work.example')
  })

  it('says a sign-in beside the account in use changed only the list', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')
    changes = []
    await accounts.signIn('claude', 'work')
    signedIn[workHome()] = 'me@work.example'
    await vi.waitFor(() => expect(changes).toEqual([['claude', 'list']]))
  })

  it('runs the CLI with the PATH it was found on', async () => {
    let seen: NodeJS.ProcessEnv = {}
    const accounts = build({
      identity: async (_kind, _binary, env) => {
        seen = env
        return { signedIn: true, email: null, plan: null }
      },
    })
    await accounts.list('claude')
    expect(seen['PATH']).toBe(join(dir, 'found-on-path'))
  })

  it('starts no CLI for a view that only wants the names', async () => {
    const identity = vi.fn(async () => ({ signedIn: true, email: 'a@b.c', plan: null }))
    const accounts = build({ identity })
    expect((await accounts.list('claude', false, true)).accounts[0]?.identity).toBeNull()
    expect(identity).not.toHaveBeenCalled()
  })

  it('signs an account out through the CLI', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')
    signedIn[workHome()] = 'me@work.example'
    expect((await accounts.list('claude', true)).accounts[1]?.identity?.email).toBe('me@work.example')

    const result = await accounts.signOut('claude', 'work')
    expect(result.error).toBeUndefined()
    expect(result.accounts[1]?.identity).toEqual({ signedIn: false, email: null, plan: null })
    expect(signedIn['']).toBe('me@home.example')
    expect((await accounts.signOut('claude', 'ghost')).error).toBe('That account no longer exists.')
  })

  it('removes an account with its home and falls back to the default if it was in use', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')
    await accounts.activate('claude', 'work')
    await writeFile(join(workHome(), '.credentials.json'), 'work sign-in')
    changes = []

    const result = await accounts.remove('claude', 'work')

    expect(result.accounts.map((a) => [a.id, a.active])).toEqual([['default', true]])
    expect(existsSync(workHome())).toBe(false)
    expect(accounts.env('claude')).toEqual({})
    expect(changes).toEqual([['claude', 'active']])
    // What the account shared is the user's, and is still there.
    expect(existsSync(join(dir, 'user', '.claude', 'projects', 'kept.jsonl'))).toBe(true)
  })

  it('will not remove an account while a turn of that provider is running', async () => {
    let running = true
    const accounts = build({ busy: async () => running })
    await accounts.add('claude', 'Work')

    const refused = await accounts.remove('claude', 'work')
    expect(refused.error).toMatch(/A turn is running/)
    expect(refused.accounts.map((a) => a.id)).toEqual(['default', 'work'])
    expect(existsSync(workHome())).toBe(true)

    running = false
    expect((await accounts.remove('claude', 'work')).error).toBeUndefined()
  })

  it('will not remove the default account', async () => {
    const accounts = build()
    expect((await accounts.remove('claude', 'default')).error).toBe('That account cannot be removed.')
    expect(existsSync(join(dir, 'user', '.claude', 'projects', 'kept.jsonl'))).toBe(true)
  })

  it('never gives a new account the folder of one that was removed', async () => {
    const accounts = build()
    // A removal that could not delete its files leaves this behind.
    await mkdir(workHome(), { recursive: true })
    await writeFile(join(workHome(), '.credentials.json'), 'someone else’s sign-in')

    const result = await accounts.add('claude', 'Work')
    expect(result.accounts[1]?.id).toBe('work-2')
  })

  it('at start-up deletes homes whose account is gone and refreshes the one in use', async () => {
    const accounts = build()
    await accounts.add('claude', 'Work')
    await accounts.activate('claude', 'work')
    const orphan = join(dir, 'accounts', 'claude', 'old')
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, '.credentials.json'), 'left behind')
    await mkdir(join(dir, 'user', '.claude', 'skills'))

    await accounts.startUp()

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(workHome(), 'skills'))).toBe(true)
    expect(existsSync(join(dir, 'user', '.claude', 'projects', 'kept.jsonl'))).toBe(true)
  })
})

describe('accountIdFor', () => {
  const free = (): boolean => false
  const taken = (...ids: string[]) => (id: string) => ids.includes(id)

  it('makes a slug the folder can be named after', () => {
    expect(accountIdFor('Work', free)).toBe('work')
    expect(accountIdFor('  Client: ACME (EU)  ', free)).toBe('client-acme-eu')
    expect(accountIdFor('2nd subscription', free)).toBe('account-2nd-subscription')
    expect(accountIdFor('日本', free)).toBe('account')
    // Windows will not create a folder with a device name.
    expect(accountIdFor('Con', free)).toBe('account-con')
    expect(accountIdFor('COM1', free)).toBe('account-com1')
  })

  it('never collides with an existing account, a leftover folder or the default', () => {
    expect(accountIdFor('Work', taken('work'))).toBe('work-2')
    expect(accountIdFor('Work', taken('work', 'work-2'))).toBe('work-3')
    expect(accountIdFor('Default', free)).toBe('default-2')
    expect(accountIdFor('x'.repeat(60), free).length).toBeLessThanOrEqual(32)
  })
})
