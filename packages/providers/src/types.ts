import type { DriverKind } from '@ari/contracts/common'

export type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown'

/**
 * Outcome of a read-only credential-store probe. `reason` is populated for
 * `unknown` verdicts so the UI can explain *why* Ari cannot tell, instead of
 * implying the user is logged out. Never contains credential values.
 */
export interface AuthProbe {
  status: AuthStatus
  reason?: string
}

export interface Detection {
  kind: DriverKind
  /**
   * True when a binary for this kind was resolved on disk. Independent of
   * auth: a missing binary is `installed: false` with `authStatus: 'unknown'`,
   * never `'unauthenticated'`.
   */
  installed: boolean
  /** Absolute path to the resolved binary, or null when not found. */
  binaryPath: string | null
  /** First line of `--version` output, trimmed. Null when probe failed. */
  version: string | null
  authStatus: AuthStatus
  /** Why `authStatus` is `'unknown'`. Omitted for decided verdicts. */
  authReason?: string
  /**
   * Newest version published upstream by the vendor, when the CLI is
   * npm-distributed and the registry answered. Null/undefined when unknown.
   */
  latestVersion?: string | null
  /** True when latestVersion is newer than version; null when unknowable. */
  updateAvailable?: boolean | null
  /**
   * False when the user turned the provider off. Such a row reports nothing
   * installed, so every consumer treats it as absent without knowing why.
   */
  enabled?: boolean
  /** Whether `binaryPath` is the user's own choice or the PATH search's. */
  pathSource?: 'custom' | 'auto'
  /**
   * What is wrong with a path the user chose. With `installed: false` the path
   * was rejected; with `installed: true` it runs but looks like the wrong file.
   */
  pathProblem?: string
  /** Every install the PATH search found, the one it would use first. */
  candidates?: string[]
  /** How Ari talks to this CLI once it is found. */
  transport?: ProviderTransport
}

export interface ProviderTransport {
  /** `acp` when turns go through the Agent Client Protocol, `cli` for one-shot runs. */
  mode: 'acp' | 'cli'
  /** What is launched, e.g. the adapter package and version. */
  label: string
  /** Something about this pairing worth knowing, e.g. a bundled CLI standing in. */
  note?: string
}

/** Everything detect() needs from the outside world; injectable for tests. */
export interface DetectEnvironment {
  platform: NodeJS.Platform
  pathEnv: string
  homeDir: string
  /** e.g. %LOCALAPPDATA% on Windows; empty string when unset. */
  localAppData?: string
  /** e.g. %APPDATA% (Roaming) on Windows; empty string when unset. */
  appData?: string
  /**
   * Raw environment variables consulted by auth probes (`XAI_API_KEY`,
   * `PI_CODING_AGENT_DIR`, `HERMES_HOME`). Injectable so tests never depend on
   * the host's real environment.
   */
  vars?: Record<string, string | undefined>
  /**
   * True when `vars` point the CLI at a home Ari built for an extra account.
   * Such a home holds nothing that authorises the CLI except its own sign-in,
   * which a home the user relocated themselves does not promise.
   */
  separateAccount?: boolean
}

export function realDetectEnvironment(): DetectEnvironment {
  return {
    platform: process.platform,
    pathEnv: process.env['PATH'] ?? '',
    homeDir: process.env[(process.platform === 'win32' ? 'USERPROFILE' : 'HOME')] ?? '',
    localAppData: process.env['LOCALAPPDATA'] ?? '',
    appData: process.env['APPDATA'] ?? '',
    vars: process.env,
  }
}
