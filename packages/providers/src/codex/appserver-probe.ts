import { createLogger } from '@ari/shared/logger'
import { spawnCli } from '../spawn-cli'

const log = createLogger('providers:codex')

/** Structural runner seam so tests can fake probe invocations. */
export type HelpRunner = (binaryPath: string) => Promise<string>

/**
 * Answers whether a codex binary ships the `app-server` JSON-RPC subcommand.
 * Results are cached per binary path: positives are final (a binary does not
 * gain subcommands at runtime), negatives are re-checked when the resolved
 * path changes (e.g. after `codex update` swaps shims).
 */
export interface AppServerProbe {
  supportsAppServer(binaryPath: string): Promise<boolean>
}

/**
 * Probes `<codex> --help` for the `app-server` subcommand and caches the
 * verdict per binary path. A missing or failing help output means "not
 * supported" — the driver then keeps the one-shot `exec --json` transport.
 */
export function createAppServerProbe(runHelp: HelpRunner = defaultRunHelp): AppServerProbe {
  const cache = new Map<string, boolean>()
  const inFlight = new Map<string, Promise<boolean>>()
  return {
    supportsAppServer(binaryPath: string): Promise<boolean> {
      const cached = cache.get(binaryPath)
      if (cached !== undefined) return Promise.resolve(cached)
      const pending = inFlight.get(binaryPath)
      if (pending) return pending
      const probe = runHelp(binaryPath)
        .then((help) => {
          // Subcommand line in `codex --help`; tolerate flag/alias noise by
          // matching the bare token on a word boundary.
          const supported = /\bapp-server\b/.test(help)
          cache.set(binaryPath, supported)
          if (!supported) {
            log.debug('codex app-server not advertised; exec --json stays the transport', {
              binaryPath,
            })
          }
          return supported
        })
        .catch((error: unknown) => {
          // A binary whose --help fails cannot be probed; treat as unsupported
          // but do not poison the cache with a permanent verdict.
          log.debug('codex probe failed; assuming no app-server', {
            binaryPath,
            error: String(error),
          })
          return false
        })
      inFlight.set(binaryPath, probe)
      void probe.finally(() => inFlight.delete(binaryPath))
      return probe
    },
  }
}

function defaultRunHelp(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(binaryPath, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.once('error', reject)
    child.once('close', () => resolve(out))
  })
}
