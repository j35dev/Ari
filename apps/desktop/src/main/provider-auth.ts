import type { DriverKind } from '@ari/contracts/common'
import type { ProviderLoginMethod, RpcResults } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'
import { AUTH_REQUIRED_ERROR } from '@ari/providers/acp/protocol'
import type { AcpTerminalLogin } from '@ari/providers/acp/protocol'

const log = createLogger('desktop:provider-auth')

/**
 * Answers "is this provider actually usable right now, and if not can Ari
 * offer the fix?" without ever touching a credential.
 *
 * The order matters: Ari always inspects the harness the user already has
 * before it offers to do anything about it. A provider whose CLI is missing,
 * or whose ACP adapter has never been fetched, is reported as `unknown` with
 * the reason — it is not a logged-out user and must never be shown a sign-in
 * prompt. Only a live `authRequired` from the agent produces `auth-required`.
 */

/** Ceiling on how long a probe verdict is trusted before re-running it. */
export const AUTH_PROBE_TTL_MS = 60_000

/** Structural surface of one ACP handshake, so tests need no subprocess. */
export interface AuthProbeConnection {
  /** Logins the agent advertised at initialize; empty when it offered none. */
  terminalLogins: AcpTerminalLogin[]
  /** Opens a throwaway session — the request Claude's adapter refuses when logged out. */
  newSession(cwd: string): Promise<unknown>
  kill(): void
}

export interface AuthProbeDeps {
  /** Cached detection round; reused rather than re-probing every binary. */
  detections: () => Promise<RpcResults['providers.detect']>
  /**
   * Opens an ACP handshake against an already-installed adapter. Must resolve
   * null when the kind has no ACP transport, and must not fetch packages —
   * a probe that downloads is a probe users will cancel.
   */
  connect: (kind: DriverKind, binaryPath: string) => Promise<AuthProbeConnection | null>
  /** Throwaway working directory for the probe session. */
  cwd: () => string
  now?: () => number
}

export type AuthProbeResult = RpcResults['providers.authProbe']

/**
 * True when the agent refused this request for want of a login. Matched on the
 * protocol's own error code rather than the class, so the check survives the
 * error crossing a package boundary or being re-wrapped.
 */
function isAuthWall(error: unknown): error is { logins: AcpTerminalLogin[] } {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return code === AUTH_REQUIRED_ERROR
}

/** Normalizes a login for the wire; identical shape, no adapter types leaking. */
export function toLoginMethods(logins: AcpTerminalLogin[] | undefined): ProviderLoginMethod[] {
  return (logins ?? []).map((login) => ({
    methodId: login.methodId,
    name: login.name,
    description: login.description,
    command: login.command,
    args: login.args,
  }))
}

/**
 * Remembers the last live auth wall per kind. A wall observed during a real
 * turn is better evidence than any probe — and it carries the login list from
 * an agent that is already running, so the UI can offer sign-in without
 * spawning a second adapter just to ask again.
 */
export class ProviderAuthState {
  readonly #walls = new Map<DriverKind, { label: string; logins: ProviderLoginMethod[]; at: number }>()
  readonly #probes = new Map<DriverKind, { result: AuthProbeResult; at: number }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Records a live refusal; also invalidates any stale `ready` probe verdict. */
  recordWall(kind: DriverKind, label: string, logins: AcpTerminalLogin[]): void {
    this.#walls.set(kind, { label, logins: toLoginMethods(logins), at: this.#now() })
    this.#probes.delete(kind)
  }

  wallFor(kind: DriverKind): { label: string; logins: ProviderLoginMethod[] } | null {
    const wall = this.#walls.get(kind)
    return wall === undefined ? null : { label: wall.label, logins: wall.logins }
  }

  /** Called once a login attempt finishes, so the next probe re-tests for real. */
  clear(kind: DriverKind): void {
    this.#walls.delete(kind)
    this.#probes.delete(kind)
  }

  cachedProbe(kind: DriverKind): AuthProbeResult | null {
    const entry = this.#probes.get(kind)
    if (entry === undefined) return null
    if (this.#now() - entry.at > AUTH_PROBE_TTL_MS) {
      this.#probes.delete(kind)
      return null
    }
    return entry.result
  }

  rememberProbe(kind: DriverKind, result: AuthProbeResult): void {
    this.#probes.set(kind, { result, at: this.#now() })
  }
}

/**
 * Preflights one provider. Reuses the cached detection round and an
 * already-fetched adapter; a kind with no installed CLI, no ACP transport, or
 * an uncached adapter answers `unknown` rather than inventing a login problem.
 */
export async function probeProviderAuth(
  kind: DriverKind,
  deps: AuthProbeDeps,
  state: ProviderAuthState,
): Promise<AuthProbeResult> {
  const cached = state.cachedProbe(kind)
  if (cached !== null) return cached

  // A wall seen during a real turn outranks anything a probe could learn.
  const wall = state.wallFor(kind)
  if (wall !== null) {
    return { status: 'auth-required', label: wall.label, logins: wall.logins }
  }

  const detections = await deps.detections()
  const detection = detections.find((d) => d.kind === kind)
  if (detection === undefined || !detection.installed || detection.binaryPath === null) {
    return {
      status: 'unknown',
      reason:
        detection?.authReason ??
        'Not installed — Ari cannot check the login until the CLI is present.',
    }
  }

  let connection: AuthProbeConnection | null
  try {
    connection = await deps.connect(kind, detection.binaryPath)
  } catch (error) {
    if (isAuthWall(error)) {
      // Some agents refuse at the handshake, before any authMethods exist.
      const result: AuthProbeResult = {
        status: 'auth-required',
        label: kind,
        logins: toLoginMethods(error.logins),
      }
      state.rememberProbe(kind, result)
      return result
    }
    log.debug('auth probe could not reach the agent', { kind, error: String(error) })
    return {
      status: 'unknown',
      reason: 'Ari could not reach this agent to check its login; the CLI manages its own sign-in.',
    }
  }
  if (connection === null) {
    return {
      status: 'unknown',
      reason: 'This provider has no ACP transport, so Ari cannot verify its login.',
    }
  }

  try {
    await connection.newSession(deps.cwd())
    const result: AuthProbeResult = {
      status: 'ready',
      label: kind,
      version: detection.version ?? null,
    }
    state.rememberProbe(kind, result)
    return result
  } catch (error) {
    if (isAuthWall(error)) {
      const result: AuthProbeResult = {
        status: 'auth-required',
        label: kind,
        logins: toLoginMethods(connection.terminalLogins.length > 0 ? connection.terminalLogins : error.logins),
      }
      state.rememberProbe(kind, result)
      return result
    }
    log.debug('auth probe session failed for a non-auth reason', { kind, error: String(error) })
    return {
      status: 'unknown',
      reason: 'Ari could not open a session to check this login; the CLI manages its own sign-in.',
    }
  } finally {
    connection.kill()
  }
}

/**
 * The logins Ari can offer for a kind. Prefers the list from a live wall;
 * otherwise runs the preflight, which fills it in as a side effect. Answers an
 * empty list when the agent offers nothing runnable — the UI must then fall
 * back to explaining the manual CLI login rather than showing a dead button.
 */
export async function resolveProviderLogins(
  kind: DriverKind,
  deps: AuthProbeDeps,
  state: ProviderAuthState,
): Promise<RpcResults['providers.login']> {
  const wall = state.wallFor(kind)
  if (wall !== null) return { label: wall.label, logins: wall.logins }
  const probe = await probeProviderAuth(kind, deps, state)
  if (probe.status === 'auth-required') return { label: probe.label, logins: probe.logins }
  return { label: kind, logins: [] }
}
