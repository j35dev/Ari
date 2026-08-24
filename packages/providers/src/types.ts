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
