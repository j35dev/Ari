import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildCmdSpawnArgs, needsWindowsShell } from '@ari/providers/spawn-cli'
import type { DriverKind } from '@ari/contracts/common'
import { resetCreditOutcomeSchema } from '@ari/contracts/rpc'
import type { ProviderResetCredits, ResetCreditOutcome } from '@ari/contracts/rpc'
import { AppServerConnection } from '@ari/providers/codex/appserver-connection'
import { createLogger } from '@ari/shared/logger'
import { err, mapErr, ok, type Result } from '@ari/shared/result'

import { parseClaudeResetCredits } from './allowance-windows'

const log = createLogger('desktop:resets')

const GRANT_ID = /^[a-z0-9_-]{1,40}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const ORG_ID = /^[A-Za-z0-9_-]{1,80}$/
const PROGRAM = 'cedar_ember'
const API_BASE = 'https://api.anthropic.com'

/**
 * One idempotency key is kept per account until the provider reports an
 * outcome. A timeout retries the same attempt instead of spending a second credit.
 */
interface Attempt {
  key: string
  creditId?: string
}

export interface ResetCreditClient {
  now(): number
  platform: NodeJS.Platform
  configDir(): string
  accountPath(): string
  readText(path: string): Promise<string | null>
  /** Semver of the installed Claude CLI. An old client is told the bank is empty. */
  cliVersion(binaryPath: string | null): Promise<string>
  fetchJson(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number },
  ): Promise<{ status: number; json: unknown }>
  codexRequest(binaryPath: string, method: string, params: unknown): Promise<unknown>
  newKey(): string
}

export interface ConsumeResetCreditInput {
  kind: DriverKind
  binaryPath: string | null
  creditId?: string | undefined
}

/** A refusal worded for the user. `retainKey` keeps the attempt for the retry. */
interface RedeemFailure {
  message: string
  retainKey: boolean
}

type Redeemed = Result<ResetCreditOutcome, RedeemFailure>

function refused(message: string, retainKey: boolean): Result<never, RedeemFailure> {
  return err({ message, retainKey })
}

function claudeConfigDir(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override && override.length > 0 ? override : join(homedir(), '.claude')
}

function claudeAccountPath(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override && override.length > 0
    ? join(override, '.claude.json')
    : join(homedir(), '.claude.json')
}

function claudeHeaders(token: string, version: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': `claude-cli/${version} (external, cli)`,
    accept: 'application/json',
  }
}

const claudeVersions = new Map<string, Promise<string>>()

/** Claude hides `cedar_ember` from clients that identify as an old CLI. */
function probeClaudeVersion(binaryPath: string | null): Promise<string> {
  const command = binaryPath && binaryPath.length > 0 ? binaryPath : 'claude'
  const cached = claudeVersions.get(command)
  if (cached) return cached
  const pending = new Promise<string>((resolve) => {
    let stdout = ''
    const finish = (version: string): void => resolve(version)
    const wrapped = needsWindowsShell(command) ? buildCmdSpawnArgs(command, ['--version']) : null
    const child = wrapped
      ? spawn(wrapped.file, wrapped.args, {
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 8_000,
        })
      : spawn(command, ['--version'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 8_000,
        })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => finish('2.1.289'))
    child.on('close', () => {
      finish(/(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? '2.1.289')
    })
  })
  claudeVersions.set(command, pending)
  return pending
}

async function readJson(client: ResetCreditClient, path: string): Promise<unknown> {
  const text = await client.readText(path)
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function readAccessToken(client: ResetCreditClient): Promise<string | null> {
  if (client.platform === 'darwin') return null
  const parsed = await readJson(client, join(client.configDir(), '.credentials.json'))
  if (!parsed || typeof parsed !== 'object') return null
  const oauth = (parsed as Record<string, unknown>)['claudeAiOauth']
  if (!oauth || typeof oauth !== 'object') return null
  const token = (oauth as Record<string, unknown>)['accessToken']
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null
}

async function readOrganization(client: ResetCreditClient): Promise<string | null> {
  const parsed = await readJson(client, client.accountPath())
  if (!parsed || typeof parsed !== 'object') return null
  const account = (parsed as Record<string, unknown>)['oauthAccount']
  if (!account || typeof account !== 'object') return null
  const org = (account as Record<string, unknown>)['organizationUuid']
  return typeof org === 'string' && ORG_ID.test(org.trim()) ? org.trim() : null
}

const defaultClient: ResetCreditClient = {
  now: Date.now,
  platform: process.platform,
  configDir: claudeConfigDir,
  accountPath: claudeAccountPath,
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  },
  cliVersion: probeClaudeVersion,
  async fetchJson(url, init) {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(init.timeoutMs),
    })
    let json: unknown
    try {
      json = (await response.json()) as unknown
    } catch {
      json = null
    }
    return { status: response.status, json }
  },
  async codexRequest(binaryPath, method, params) {
    const connection = AppServerConnection.start({ binaryPath, cwd: homedir() })
    try {
      await connection.request(
        'initialize',
        { clientInfo: { name: 'ari-usage', version: '0.1.0' } },
        10_000,
      )
      return await connection.request(method, params, 20_000)
    } finally {
      await connection.shutdown()
    }
  },
  newKey: randomUUID,
}

/** Reads Claude's bank. Any failure is "no resets" so the usage bars still render. */
export async function readClaudeResetCredits(
  client: ResetCreditClient = defaultClient,
  binaryPath: string | null = null,
): Promise<ProviderResetCredits | null> {
  const token = await readAccessToken(client)
  if (!token) return null
  const version = await client.cliVersion(binaryPath)
  const { status, json } = await client.fetchJson(
    `${API_BASE}/api/oauth/usage?cedar_ember=1&skip_spend=1`,
    { method: 'GET', headers: claudeHeaders(token, version), timeoutMs: 10_000 },
  )
  if (status !== 200 || !json || typeof json !== 'object') {
    throw new Error('Claude reset bank unread')
  }
  return parseClaudeResetCredits((json as Record<string, unknown>)['cedar_ember'], client.now())
}

function mapClaudeResult(result: string): Redeemed {
  switch (result) {
    case 'reset':
      return ok('reset')
    case 'not_limited':
      return ok('nothingToReset')
    case 'already_used':
      return ok('alreadyRedeemed')
    case 'ineligible':
      return ok('noCredit')
    case 'cooldown':
      return refused('Claude resets are cooling down. Try again later.', false)
    case 'unavailable':
      return refused(
        'Claude could not confirm the reset. If you are still limited in a moment, try again.',
        true,
      )
    default:
      return refused('Claude could not use the reset.', true)
  }
}

export function createResetCreditService(client: ResetCreditClient = defaultClient) {
  const pending = new Map<string, Attempt>()
  const inflight = new Map<string, Promise<Result<ResetCreditOutcome, string>>>()

  async function redeemCodex(binaryPath: string, key: string): Promise<Redeemed> {
    let raw: unknown
    try {
      raw = await client.codexRequest(binaryPath, 'account/rateLimitResetCredit/consume', {
        idempotencyKey: key,
      })
    } catch (error) {
      log.debug('Codex reset failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      })
      return refused('Codex could not use the reset.', true)
    }
    const parsed = resetCreditOutcomeSchema.safeParse(
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['outcome'] : raw,
    )
    return parsed.success ? ok(parsed.data) : refused('Codex could not use the reset.', true)
  }

  async function redeemClaude(
    accountKey: string,
    attempt: Attempt,
    binaryPath: string | null,
  ): Promise<Redeemed> {
    const token = await readAccessToken(client)
    if (!token) return refused('Sign in to Claude again to use a reset.', false)
    const version = await client.cliVersion(binaryPath)
    let creditId = attempt.creditId
    if (!creditId) {
      creditId = (await readClaudeResetCredits(client, binaryPath))?.nextCreditId
      if (!creditId) return ok('noCredit')
      pending.set(accountKey, { ...attempt, creditId })
    }
    if (!GRANT_ID.test(creditId) || !REQUEST_ID.test(attempt.key)) {
      return refused('That reset credit is not valid.', false)
    }
    const organization = await readOrganization(client)
    if (!organization) return refused('Sign in to Claude again to use a reset.', false)
    let response: { status: number; json: unknown }
    try {
      response = await client.fetchJson(
        `${API_BASE}/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
        {
          method: 'POST',
          headers: { ...claudeHeaders(token, version), 'content-type': 'application/json' },
          body: JSON.stringify({
            program: PROGRAM,
            grant_id: creditId,
            request_id: attempt.key,
          }),
          timeoutMs: 25_000,
        },
      )
    } catch (error) {
      log.debug('Claude reset failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      })
      return refused('Claude could not use the reset.', true)
    }
    if (response.status === 429) {
      return refused('Claude is rate limiting resets. Try again soon.', false)
    }
    if (response.status === 401 || response.status === 403) {
      return refused('Sign in to Claude again to use a reset.', false)
    }
    if (response.status !== 200) return refused('Claude could not use the reset.', true)
    const result =
      response.json && typeof response.json === 'object'
        ? (response.json as Record<string, unknown>)['result']
        : undefined
    return mapClaudeResult(typeof result === 'string' ? result : '')
  }

  async function redeem(
    accountKey: string,
    input: ConsumeResetCreditInput,
  ): Promise<Result<ResetCreditOutcome, string>> {
    let attempt = pending.get(accountKey) ?? { key: client.newKey() }
    if (!attempt.creditId && input.creditId) attempt = { ...attempt, creditId: input.creditId }
    pending.set(accountKey, attempt)
    let redeemed: Redeemed
    try {
      redeemed =
        input.kind === 'codex'
          ? await redeemCodex(input.binaryPath ?? '', attempt.key)
          : await redeemClaude(accountKey, attempt, input.binaryPath)
    } catch (error) {
      log.debug('Reset redemption failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      })
      redeemed = refused('Could not use the reset.', false)
    }
    if (redeemed.ok || !redeemed.error.retainKey) pending.delete(accountKey)
    return mapErr(redeemed, (failure) => failure.message)
  }

  function accountKey(input: ConsumeResetCreditInput): Result<string | null, string> {
    if (input.kind === 'codex') return ok(input.binaryPath ? 'codex' : null)
    if (input.kind !== 'claude') return ok(null)
    if (client.platform === 'darwin') {
      return err('Claude resets stay in the Keychain on macOS and cannot be used from here.')
    }
    return ok(`claude:${client.configDir()}`)
  }

  return {
    readClaude: (binaryPath?: string | null) => readClaudeResetCredits(client, binaryPath ?? null),
    /** Resolves with the provider's outcome, or with the message to show when it refused. */
    consume(input: ConsumeResetCreditInput): Promise<Result<ResetCreditOutcome, string>> {
      const account = accountKey(input)
      if (!account.ok) return Promise.resolve(account)
      const key = account.value
      if (!key) return Promise.resolve(ok('noCredit'))
      const existing = inflight.get(key)
      if (existing) return existing
      const run = redeem(key, input).finally(() => {
        if (inflight.get(key) === run) inflight.delete(key)
      })
      inflight.set(key, run)
      return run
    },
  }
}

export const resetCreditService = createResetCreditService()
