import type { TailscaleState } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'

/**
 * The address a phone can reach Ari at, and the exact origins the gateway
 * allows (ADR §5).
 *
 * Tailscale is a subprocess call, and both `clientOrigin` and `allowedOrigins`
 * are consulted per request, so the last reading is cached here. The tailnet
 * origin is also written through to settings when it first appears: a phone
 * that paired yesterday must still be an allowed origin after a restart, and
 * at that point the gateway may not have re-read Serve yet.
 */

const log = createLogger('desktop:remote-origins')

const NOTHING: TailscaleState = {
  installed: false,
  dnsName: null,
  origin: null,
  serving: false,
  error: null,
}

export interface RemoteOriginsDeps {
  /** Reads Tailscale's current state, however that is arranged. */
  status: () => Promise<TailscaleState>
  /** Origins the user or the managed service configured explicitly. */
  configured: () => readonly string[]
  /** Persists the tailnet origin so it survives a restart. */
  remember: (origin: string) => Promise<void>
}

export class RemoteOrigins {
  readonly #deps: RemoteOriginsDeps
  #state: TailscaleState = NOTHING
  /** Origins already written through, so a refresh loop does not rewrite them. */
  readonly #written = new Set<string>()

  constructor(deps: RemoteOriginsDeps) {
    this.#deps = deps
  }

  /** Re-reads Tailscale and remembers the tailnet origin the first time it serves. */
  async refresh(): Promise<TailscaleState> {
    this.#state = await this.#deps.status()
    const origin = this.#servedOrigin()
    if (origin !== null && !this.#known(origin)) {
      this.#written.add(origin.toLowerCase())
      try {
        await this.#deps.remember(origin)
      } catch (error) {
        // Failing to persist must not take the gateway's own allowlist down:
        // the origin is still added in memory for this run.
        log.warn('could not remember the tailnet origin', { origin, error: String(error) })
      }
    }
    return this.#state
  }

  /** The address a phone should open, or null when Serve is not exposing Ari. */
  clientOrigin(): string | null {
    return this.#servedOrigin()
  }

  /** Exact origins to allow: what is configured, plus the tailnet while serving. */
  allowedOrigins(): readonly string[] {
    const configured = this.#deps.configured()
    const origin = this.#servedOrigin()
    if (origin === null) return configured
    if (configured.some((entry) => entry.toLowerCase() === origin.toLowerCase())) return configured
    return [...configured, origin]
  }

  /** The last reading, for the status RPC. */
  state(): TailscaleState {
    return this.#state
  }

  #servedOrigin(): string | null {
    return this.#state.serving ? this.#state.origin : null
  }

  #known(origin: string): boolean {
    const normalized = origin.toLowerCase()
    if (this.#written.has(normalized)) return true
    return this.#deps.configured().some((entry) => entry.toLowerCase() === normalized)
  }
}
