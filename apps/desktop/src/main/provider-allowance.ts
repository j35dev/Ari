import { homedir } from 'node:os'
import type { DriverKind } from '@ari/contracts/common'
import type { ProviderAllowance } from '@ari/contracts/rpc'
import { AcpConnection } from '@ari/providers/acp/connection'
import {
  probeLaunch,
  resolveAcpLaunch,
  type BundledAcpRuntime,
} from '@ari/providers/acp/launches'
import { AppServerConnection } from '@ari/providers/codex/appserver-connection'
import { createLogger } from '@ari/shared/logger'

import { parseAllowance } from './allowance-windows'

const log = createLogger('desktop:allowance')
type Windows = ProviderAllowance['windows']

/** Fetches account usage without starting a model turn in the user's session. */
export async function fetchAllowance(
  kind: DriverKind,
  binaryPath: string,
  bundledRuntime?: BundledAcpRuntime,
): Promise<Windows> {
  if (kind === 'codex') {
    // Ari's pinned ACP /status reads a stale snapshot. The underlying native
    // account request actively fetches limits, even without an active turn.
    const connection = AppServerConnection.start({ binaryPath, cwd: homedir() })
    try {
      await connection.request(
        'initialize',
        { clientInfo: { name: 'ari-usage', version: '0.1.0' } },
        10_000,
      )
      return parseAllowance(kind, await connection.request('account/rateLimits/read', {}, 10_000))
    } finally {
      await connection.shutdown()
    }
  }
  const launch = resolveAcpLaunch(kind, { cliBinaryPath: binaryPath, bundledRuntime })
  if (!launch || (kind !== 'grok' && kind !== 'claude')) return []
  const connection = await AcpConnection.connect({
    launch: probeLaunch(launch),
    cwd: homedir(),
    initializeTimeoutMs: 15_000,
  })
  try {
    if (kind === 'grok')
      return parseAllowance(kind, await connection.requestExtension('_x.ai/billing', {}))
    let text = ''
    let advertised = false
    let announce: () => void = () => undefined
    const commandsReady = new Promise<void>((resolve) => {
      announce = resolve
    })
    connection.onSessionUpdate = ({ update }) => {
      const commands = (update as { availableCommands?: { name?: string }[] } | undefined)
        ?.availableCommands
      if (Array.isArray(commands)) {
        advertised = commands.some((command) => command?.name === 'usage')
        announce()
      }
      if (update?.sessionUpdate === 'agent_message_chunk' && !Array.isArray(update.content)) {
        text = (text + (update.content?.text ?? '')).slice(0, 32_000)
      }
    }
    const session = await connection.newSession(homedir())
    const commandDeadline = setTimeout(announce, 1500)
    await commandsReady
    clearTimeout(commandDeadline)
    if (!advertised || !session.sessionId) return []
    // /usage is a CLI command, advertised by this adapter; never guess a slash
    // command and accidentally submit it as a paid model prompt.
    await connection.prompt(session.sessionId, '/usage', { timeoutMs: 10_000 })
    return parseAllowance(kind, text)
  } finally {
    await connection.shutdown()
  }
}

/** Coalesces concurrent reads and keeps the last successful sample on failures. */
export class ProviderAllowanceReader {
  readonly #pending = new Map<string, Promise<ProviderAllowance>>()
  readonly #last = new Map<string, ProviderAllowance>()
  constructor(
    private readonly fetch: typeof fetchAllowance = fetchAllowance,
    private readonly now = Date.now,
  ) {}

  read(kind: DriverKind, binaryPath: string | null): Promise<ProviderAllowance> {
    const key = `${kind}:${binaryPath ?? ''}`
    const pending = this.#pending.get(key)
    if (pending) return pending
    const read = this.#read(kind, binaryPath, key).finally(() => this.#pending.delete(key))
    this.#pending.set(key, read)
    return read
  }

  async #read(
    kind: DriverKind,
    binaryPath: string | null,
    key: string,
  ): Promise<ProviderAllowance> {
    try {
      const windows = binaryPath ? await this.fetch(kind, binaryPath) : []
      const result: ProviderAllowance = {
        kind,
        windows,
        status: windows.length ? 'available' : 'unavailable',
        updatedAt: windows.length ? this.now() : null,
        checkedAt: this.now(),
        detail: windows.length ? '' : 'This provider did not expose account allowance.',
      }
      this.#last.set(key, result)
      return result
    } catch (error) {
      log.debug('Account allowance refresh failed', {
        kind,
        error: error instanceof Error ? error.name : 'UnknownError',
      })
      const last = this.#last.get(key)
      return {
        kind,
        status: 'error',
        windows: last?.windows ?? [],
        updatedAt: last?.updatedAt ?? null,
        checkedAt: this.now(),
        detail: 'Could not refresh usage. Retrying automatically.',
      }
    }
  }
}
