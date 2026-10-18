import type { RpcResults } from '@ari/contracts/rpc'
import type { ProviderAuthEntry } from './use-provider-auth'
import type { InstallState } from './use-provider-installs'

export type Detection = RpcResults['providers.detect'][number]

/** `quiet` covers states that are nobody's problem: off, built in, not installed. */
export type StatusTone = 'ok' | 'update' | 'warning' | 'error' | 'quiet' | 'busy'

export interface ProviderStatus {
  tone: StatusTone
  /** Two or three words for the list row. */
  headline: string
  /** The sentence behind the headline, when there is one worth reading. */
  detail: string | null
}

export interface ProviderStatusInput {
  kind: string
  /** Undefined until the first detection round answers. */
  detection: Detection | undefined
  /** The stored setting, which leads detection by one round after a toggle. */
  enabled: boolean
  auth?: ProviderAuthEntry | undefined
  install?: InstallState | undefined
}

/**
 * The one line a provider row shows. Ordered by what the user has to act on
 * first: a provider that cannot start outranks one that merely has an update,
 * and what Ari saw a turn do outranks what a credential file implies.
 */
export function providerStatus({
  kind,
  detection,
  enabled,
  auth,
  install,
}: ProviderStatusInput): ProviderStatus {
  if (kind === 'ari-core') {
    return { tone: 'quiet', headline: 'Built in', detail: 'Runs on the endpoints you add.' }
  }
  if (!enabled) {
    return {
      tone: 'quiet',
      headline: 'Off',
      detail: 'Hidden from the model picker and never launched.',
    }
  }
  if (detection === undefined || detection.enabled === false) {
    return { tone: 'busy', headline: 'Checking', detail: null }
  }
  if (install != null && install.outcome === null) {
    return {
      tone: 'busy',
      headline: install.operation === 'install' ? 'Installing' : 'Updating',
      detail: null,
    }
  }
  if (!detection.installed) {
    if (detection.pathProblem !== undefined) {
      return { tone: 'error', headline: 'Path not usable', detail: detection.pathProblem }
    }
    return { tone: 'quiet', headline: 'Not installed', detail: 'No CLI found on PATH.' }
  }
  if (auth?.result.status === 'auth-required') {
    return {
      tone: 'warning',
      headline: 'Sign-in needed',
      detail: `${auth.result.label} refused a turn until you sign in again.`,
    }
  }
  if (detection.authStatus === 'unauthenticated' && auth?.result.status !== 'ready') {
    return {
      tone: 'warning',
      headline: 'Not signed in',
      detail: 'Sign in with the CLI to use it.',
    }
  }
  if (detection.pathProblem !== undefined) {
    return { tone: 'warning', headline: 'Check the path', detail: detection.pathProblem }
  }
  if (detection.updateAvailable === true) {
    return {
      tone: 'update',
      headline: 'Update available',
      detail: detection.latestVersion != null ? `Version ${detection.latestVersion}` : null,
    }
  }
  if (detection.authStatus === 'authenticated' || auth?.result.status === 'ready') {
    return { tone: 'ok', headline: 'Ready', detail: 'Signed in.' }
  }
  return {
    tone: 'ok',
    headline: 'Installed',
    detail: 'Sign-in not verified.',
  }
}

/** `2.1.296 (Claude Code)` and `codex-cli 0.160.0` both read as `2.1.296` / `0.160.0`. */
export function shortVersion(version: string | null | undefined): string | null {
  if (version == null) return null
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(version)?.[0] ?? version
}

/** "just now", "3 min ago", "2 h ago" for the last-checked label. */
export function checkedAgo(checkedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  return `${Math.floor(minutes / 60)} h ago`
}
