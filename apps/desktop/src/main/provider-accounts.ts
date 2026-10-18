import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAccountRow, ProviderAccountsResult } from '@ari/contracts/rpc'
import { DEFAULT_ACCOUNT, activeAccountId, cliKindSchema } from '@ari/contracts/settings'
import type { CliKind, ProviderAccount, Settings } from '@ari/contracts/settings'
import type { SettingsPatch } from '@ari/engine/settings'
import {
  accountEnvironment,
  prepareAccountHome,
  removeAccountHome,
  supportsAccounts,
} from '@ari/providers/account-home'
import {
  accountLoginArgs,
  readAccountIdentity,
  signOutAccount,
} from '@ari/providers/account-identity'
import type { AccountIdentity } from '@ari/providers/account-identity'
import { processEnvWithPath } from '@ari/providers/shell-env'
import type { DetectEnvironment } from '@ari/providers/types'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:accounts')

/** How long an account's "signed in as" answer is reused before the CLI is asked again. */
const IDENTITY_TTL_MS = 60_000
/** How often an account is asked who it is while its sign-in is open in a terminal. */
const SIGN_IN_POLL_MS = 3_000
/** How long a sign-in is watched before Ari stops asking. */
const SIGN_IN_WATCH_MS = 5 * 60_000

/** Folder names Windows reserves; an account home cannot be called one. */
const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)$/

export interface ProviderAccountsDeps {
  /** The folder every extra account's home lives under. */
  root: string
  settings: () => Settings
  update: (patch: SettingsPatch) => Promise<Settings>
  detectEnvironment: () => Promise<DetectEnvironment>
  /** The CLI Ari runs for a kind, or null when it is off, missing or mis-set. */
  binaryPath: (kind: DriverKind) => Promise<string | null>
  /** True while any turn of that provider is running. */
  busy: (kind: DriverKind) => Promise<boolean>
  /**
   * Called after a change. `active` means who the provider runs as is now
   * different (a switch, or the account in use signing in or out); `list`
   * means only the set of accounts, or one beside the one in use, changed.
   */
  changed: (kind: CliKind, what: 'active' | 'list') => void
  identity?: typeof readAccountIdentity
  signOut?: typeof signOutAccount
  now?: () => number
  signInPollMs?: number
}

/** What the renderer needs to run a provider's own sign-in for one account in a terminal. */
export interface AccountSignIn {
  title: string
  command: string
  args: string[]
  env: Record<string, string>
}

function patchFor(
  kind: CliKind,
  fields: { accounts?: ProviderAccount[]; activeAccount?: string },
): SettingsPatch {
  return { providers: { [kind]: fields } }
}

/**
 * Turns a label into the slug that names an account's home. `taken` says
 * whether an id is spoken for, by a stored account or by a folder left behind,
 * so a new account can never inherit the files of a removed one.
 */
export function accountIdFor(label: string, taken: (id: string) => boolean): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const named = /^[a-z]/.test(slug) && !RESERVED.test(slug) ? slug : `account-${slug}`
  const stem = named.replace(/-+$/, '').slice(0, 28)
  let id = stem
  for (let n = 2; id === DEFAULT_ACCOUNT || taken(id); n++) id = `${stem}-${String(n)}`
  return id
}

/**
 * The accounts a provider can run as. The default account is whatever the CLI
 * is signed into in its own home; each further one gets a home of its own that
 * holds only its sign-in and shares the rest. Signing in and out is the CLI's
 * doing, in that home: Ari neither copies nor moves a credential.
 */
export class ProviderAccounts {
  readonly #deps: ProviderAccountsDeps
  readonly #identities = new Map<string, { at: number; value: AccountIdentity | null }>()
  readonly #watches = new Map<string, () => void>()
  #queue: Promise<unknown> = Promise.resolve()

  constructor(deps: ProviderAccountsDeps) {
    this.#deps = deps
  }

  /** The home of one account; null for the default, which is left where the CLI keeps it. */
  homeOf(kind: DriverKind, id: string): string | null {
    return id === DEFAULT_ACCOUNT ? null : join(this.#deps.root, kind, id)
  }

  #connection(kind: DriverKind): { kind: CliKind; accounts: ProviderAccount[]; active: string } | null {
    const cli = cliKindSchema.safeParse(kind)
    if (!cli.success || !supportsAccounts(kind)) return null
    const connection = this.#deps.settings().providers[cli.data]
    return { kind: cli.data, accounts: connection.accounts, active: activeAccountId(connection) }
  }

  /** The id of the account a kind currently runs as. */
  activeId(kind: DriverKind): string {
    return this.#connection(kind)?.active ?? DEFAULT_ACCOUNT
  }

  /**
   * The variables that make a CLI run as an account: the active one unless
   * `id` names another. Empty for the default account and for providers
   * without accounts, so callers can spread it unconditionally.
   */
  env(kind: DriverKind, id = this.activeId(kind)): Record<string, string> {
    return accountEnvironment(kind, this.homeOf(kind, id))
  }

  /** Adding, switching and removing run one at a time, each on the settings the last left. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const done = this.#queue.then(task)
    this.#queue = done.catch(() => undefined)
    return done
  }

  /**
   * The environment for a CLI run on an account's behalf. It needs the PATH
   * detection found the CLI with: a GUI-launched Ari cannot otherwise run a
   * shim that shells out to a version-managed Node.
   */
  async #processEnv(kind: DriverKind, id: string): Promise<NodeJS.ProcessEnv> {
    const { pathEnv } = await this.#deps.detectEnvironment()
    return { ...processEnvWithPath(pathEnv), ...this.env(kind, id) }
  }

  async #identity(kind: CliKind, id: string, fresh: boolean): Promise<AccountIdentity | null> {
    const key = `${kind}:${id}`
    const now = (this.#deps.now ?? Date.now)()
    const cached = this.#identities.get(key)
    if (!fresh && cached !== undefined && now - cached.at < IDENTITY_TTL_MS) return cached.value
    const binaryPath = await this.#deps.binaryPath(kind)
    if (binaryPath === null) return null
    let value: AccountIdentity | null = null
    try {
      value = await (this.#deps.identity ?? readAccountIdentity)(
        kind,
        binaryPath,
        await this.#processEnv(kind, id),
      )
    } catch (error) {
      log.debug('account identity read failed', { kind, error: String(error) })
    }
    this.#identities.set(key, { at: now, value })
    return value
  }

  /**
   * The accounts of a provider. `brief` starts no CLI: each identity is what
   * was last learned, or null. For views that only need the names.
   */
  async list(kind: DriverKind, fresh = false, brief = false): Promise<ProviderAccountsResult> {
    const connection = this.#connection(kind)
    if (connection === null) return { supported: false, accounts: [] }
    const entries = [{ id: DEFAULT_ACCOUNT, label: 'Default' }, ...connection.accounts]
    const accounts = await Promise.all(
      entries.map(
        async (entry): Promise<ProviderAccountRow> => ({
          id: entry.id,
          label: entry.label,
          isDefault: entry.id === DEFAULT_ACCOUNT,
          active: entry.id === connection.active,
          identity: brief
            ? (this.#identities.get(`${connection.kind}:${entry.id}`)?.value ?? null)
            : await this.#identity(connection.kind, entry.id, fresh),
        }),
      ),
    )
    return { supported: true, accounts }
  }

  async #failed(kind: DriverKind, error: string): Promise<ProviderAccountsResult> {
    return { ...(await this.list(kind, false, true)), error }
  }

  add(kind: DriverKind, label: string): Promise<ProviderAccountsResult> {
    return this.#serial(async () => {
      const connection = this.#connection(kind)
      if (connection === null) return { supported: false, accounts: [] }
      const name = label.trim().slice(0, 40)
      if (name.length === 0) return this.#failed(kind, 'Give the account a name.')
      const id = accountIdFor(
        name,
        (candidate) =>
          connection.accounts.some((account) => account.id === candidate) ||
          existsSync(join(this.#deps.root, kind, candidate)),
      )
      try {
        await this.#prepare(connection.kind, id)
        const accounts = [...connection.accounts, { id, label: name }]
        await this.#deps.update(patchFor(connection.kind, { accounts }))
      } catch (error) {
        log.warn('could not add an account', { kind, error: String(error) })
        return this.#failed(kind, 'Could not create the account.')
      }
      this.#deps.changed(connection.kind, 'list')
      return this.list(kind)
    })
  }

  /** Makes sure an extra account's home exists and shares what it should. */
  async #prepare(kind: CliKind, id: string): Promise<void> {
    const home = this.homeOf(kind, id)
    if (home === null) return
    const report = await prepareAccountHome(kind, home, await this.#deps.detectEnvironment())
    if (report.skipped.length > 0) {
      log.warn('an account home does not share everything', { kind, skipped: report.skipped })
    }
  }

  /**
   * Run once at start-up. Brings the homes of the accounts in use up to date,
   * so what the default home gained since the last run (a new skills folder, a
   * first plugin) is shared with them too, and deletes any home whose account
   * is gone from settings: one a removal could not finish because its files
   * were in use, sign-in included.
   */
  async startUp(): Promise<void> {
    for (const kind of cliKindSchema.options) {
      const connection = this.#connection(kind)
      if (connection === null) continue
      const folder = join(this.#deps.root, kind)
      const left = await readdir(folder).catch(() => [])
      for (const id of left) {
        if (connection.accounts.some((account) => account.id === id)) continue
        await removeAccountHome(join(folder, id), this.#deps.root).catch((error: unknown) =>
          log.warn('could not delete a removed account’s files', { kind, error: String(error) }),
        )
      }
      if (connection.active === DEFAULT_ACCOUNT) continue
      await this.#prepare(kind, connection.active).catch((error: unknown) =>
        log.warn('could not prepare the active account home', { kind, error: String(error) }),
      )
    }
  }

  activate(kind: DriverKind, id: string): Promise<ProviderAccountsResult> {
    return this.#serial(async () => {
      const connection = this.#connection(kind)
      if (connection === null) return { supported: false, accounts: [] }
      const known =
        id === DEFAULT_ACCOUNT || connection.accounts.some((account) => account.id === id)
      if (!known) return this.#failed(kind, 'That account no longer exists.')
      if (id !== connection.active) {
        try {
          await this.#prepare(connection.kind, id)
          await this.#deps.update(patchFor(connection.kind, { activeAccount: id }))
        } catch (error) {
          log.warn('could not switch account', { kind, error: String(error) })
          return this.#failed(kind, 'Could not switch to that account.')
        }
        this.#deps.changed(connection.kind, 'active')
      }
      return this.list(kind)
    })
  }

  /**
   * The CLI's own sign-in for one account, for the renderer to run in a
   * terminal tab. The sign-in happens out of Ari's sight, so the account is
   * asked who it is every few seconds until it answers signed in, or the
   * watch runs out; the answer is announced like any other change.
   */
  async signIn(kind: DriverKind, id: string): Promise<AccountSignIn | null> {
    const connection = this.#connection(kind)
    const args = accountLoginArgs(kind)
    if (connection === null || args === null) return null
    const account = connection.accounts.find((entry) => entry.id === id)
    if (id !== DEFAULT_ACCOUNT && account === undefined) return null
    const command = await this.#deps.binaryPath(kind)
    if (command === null) return null
    await this.#prepare(connection.kind, id)
    this.#identities.delete(`${kind}:${id}`)
    this.#watch(connection.kind, id)
    return {
      title: `${account?.label ?? 'Default'} sign-in`,
      command,
      args,
      env: this.env(kind, id),
    }
  }

  #watch(kind: CliKind, id: string): void {
    const key = `${kind}:${id}`
    this.#watches.get(key)?.()
    const started = Date.now()
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = (): void => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      if (this.#watches.get(key) === stop) this.#watches.delete(key)
    }
    const ask = async (): Promise<void> => {
      const identity = await this.#identity(kind, id, true)
      if (stopped) return
      if (identity?.signedIn === true) {
        stop()
        this.#deps.changed(kind, id === this.activeId(kind) ? 'active' : 'list')
      } else if (Date.now() - started > SIGN_IN_WATCH_MS) stop()
      else schedule()
    }
    // The next question is only put once the last was answered.
    const schedule = (): void => {
      timer = setTimeout(() => void ask(), this.#deps.signInPollMs ?? SIGN_IN_POLL_MS)
      timer.unref?.()
    }
    this.#watches.set(key, stop)
    schedule()
  }

  /** Stops watching every sign-in. For shutdown and tests. */
  close(): void {
    for (const stop of [...this.#watches.values()]) stop()
  }

  async #signOutVia(kind: DriverKind, id: string): Promise<boolean> {
    const binaryPath = await this.#deps.binaryPath(kind)
    if (binaryPath === null) return false
    try {
      return await (this.#deps.signOut ?? signOutAccount)(
        kind,
        binaryPath,
        await this.#processEnv(kind, id),
      )
    } catch (error) {
      log.warn('sign-out through the CLI failed', { kind, error: String(error) })
      return false
    }
  }

  signOut(kind: DriverKind, id: string): Promise<ProviderAccountsResult> {
    return this.#serial(async () => {
      const connection = this.#connection(kind)
      if (connection === null) return { supported: false, accounts: [] }
      const known =
        id === DEFAULT_ACCOUNT || connection.accounts.some((account) => account.id === id)
      if (!known) return this.#failed(kind, 'That account no longer exists.')
      this.#watches.get(`${kind}:${id}`)?.()
      const done = await this.#signOutVia(kind, id)
      this.#identities.delete(`${kind}:${id}`)
      this.#deps.changed(connection.kind, id === connection.active ? 'active' : 'list')
      const listed = await this.list(kind, true)
      return done ? listed : { ...listed, error: 'The CLI did not confirm the sign-out.' }
    })
  }

  /** Forgets an extra account and deletes its home, sign-in included. */
  remove(kind: DriverKind, id: string): Promise<ProviderAccountsResult> {
    return this.#serial(async () => {
      const connection = this.#connection(kind)
      if (connection === null) return { supported: false, accounts: [] }
      const home = this.homeOf(kind, id)
      if (home === null || !connection.accounts.some((account) => account.id === id)) {
        return this.#failed(kind, 'That account cannot be removed.')
      }
      // A turn may be running in the home about to be deleted, with its files
      // open and its conversation being written through the links.
      if (await this.#deps.busy(kind)) {
        return this.#failed(kind, 'A turn is running on this provider. Stop it, then remove the account.')
      }
      const wasActive = id === connection.active
      try {
        // Settings first: once the account is gone from them nothing new can
        // start in the home that is about to be deleted.
        await this.#deps.update(
          patchFor(connection.kind, {
            accounts: connection.accounts.filter((account) => account.id !== id),
            ...(wasActive ? { activeAccount: DEFAULT_ACCOUNT } : {}),
          }),
        )
      } catch (error) {
        log.warn('could not remove an account', { kind, error: String(error) })
        return this.#failed(kind, 'Could not remove the account.')
      }
      this.#watches.get(`${kind}:${id}`)?.()
      this.#identities.delete(`${kind}:${id}`)
      this.#deps.changed(connection.kind, wasActive ? 'active' : 'list')
      // Through the CLI first: on macOS the sign-in is in the Keychain, where
      // deleting the folder would leave it behind.
      await this.#signOutVia(kind, id)
      try {
        await removeAccountHome(home, this.#deps.root)
      } catch (error) {
        log.warn('could not delete an account’s files', { kind, error: String(error) })
        return this.#failed(
          kind,
          'The account is removed, but some of its files are in use. Ari will delete them when it next starts.',
        )
      }
      return this.list(kind)
    })
  }
}
