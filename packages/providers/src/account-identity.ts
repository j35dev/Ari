import { homedir } from 'node:os'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { AppServerConnection } from './codex/appserver-connection'
import { spawnCli } from './spawn-cli'
import { teardownChild } from './teardown'

const log = createLogger('providers:accounts')

/** Who a provider's CLI is signed in as, as far as the CLI itself will say. */
export interface AccountIdentity {
  signedIn: boolean
  email: string | null
  /** The subscription or key type as the provider names it, e.g. `max`, `plus`. */
  plan: string | null
}

const SIGNED_OUT: AccountIdentity = { signedIn: false, email: null, plan: null }

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

/** Reads `claude auth status --json`; the CLI exits non-zero when signed out but still answers. */
export function parseClaudeIdentity(stdout: string): AccountIdentity | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const status = parsed as Record<string, unknown>
  if (typeof status['loggedIn'] !== 'boolean') return null
  if (!status['loggedIn']) return SIGNED_OUT
  return {
    signedIn: true,
    email: text(status['email']),
    // An API key or a cloud provider has no subscription; the method names it instead.
    plan: text(status['subscriptionType']) ?? text(status['authMethod']),
  }
}

/** Reads the answer to the Codex app-server's `account/read`. */
export function parseCodexIdentity(result: unknown): AccountIdentity | null {
  if (typeof result !== 'object' || result === null || !('account' in result)) return null
  const account: unknown = result.account
  if (account === null) return SIGNED_OUT
  if (typeof account !== 'object') return null
  const fields = account as Record<string, unknown>
  return {
    signedIn: true,
    email: text(fields['email']),
    plan: text(fields['planType']) ?? text(fields['type']),
  }
}

function capture(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(stdout)
    }
    const timer = setTimeout(() => {
      // The whole tree: on Windows the CLI sits behind a cmd.exe shim, and
      // killing the shim alone would leave it running.
      if (child !== null) void teardownChild(child)
      done()
    }, timeoutMs)
    let child: ReturnType<typeof spawnCli> | null = null
    try {
      child = spawnCli(binaryPath, args, { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      log.debug('identity command could not start', { binaryPath, error: String(error) })
      done()
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', done)
    child.on('close', done)
  })
}

/**
 * Asks a provider's own CLI who it is signed in as, in the environment given
 * (which is what selects the account). Null when the CLI could not say; that
 * is "unknown", never "signed out". No credential file is read.
 */
export async function readAccountIdentity(
  kind: DriverKind,
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<AccountIdentity | null> {
  if (kind === 'claude') {
    return parseClaudeIdentity(await capture(binaryPath, ['auth', 'status', '--json'], env, 15_000))
  }
  if (kind === 'codex') {
    const connection = AppServerConnection.start({ binaryPath, cwd: homedir(), env })
    try {
      await connection.request(
        'initialize',
        { clientInfo: { name: 'ari-accounts', version: '0.1.0' } },
        10_000,
      )
      return parseCodexIdentity(
        await connection.request('account/read', { refreshToken: false }, 10_000),
      )
    } catch (error) {
      log.debug('codex account read failed', { error: String(error) })
      return null
    } finally {
      await connection.shutdown()
    }
  }
  return null
}

/** The CLI's own interactive sign-in, to be run in a terminal the user can see. */
export function accountLoginArgs(kind: DriverKind): string[] | null {
  if (kind === 'claude') return ['auth', 'login']
  if (kind === 'codex') return ['login']
  return null
}

/** Signs the account in `env` out through the CLI. True when the CLI reported success. */
export async function signOutAccount(
  kind: DriverKind,
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const args = kind === 'claude' ? ['auth', 'logout'] : kind === 'codex' ? ['logout'] : null
  if (args === null) return false
  await capture(binaryPath, args, env, 20_000)
  return (await readAccountIdentity(kind, binaryPath, env))?.signedIn === false
}
