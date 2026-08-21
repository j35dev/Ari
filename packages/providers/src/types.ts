import type { DriverKind } from '@ari/contracts/common'

export type AuthStatus = 'authenticated' | 'unauthenticated' | 'unknown'

export interface Detection {
  kind: DriverKind
  /** Absolute path to the resolved binary, or null when not found. */
  binaryPath: string | null
  /** First line of `--version` output, trimmed. Null when probe failed. */
  version: string | null
  authStatus: AuthStatus
}

/** Everything detect() needs from the outside world; injectable for tests. */
export interface DetectEnvironment {
  platform: NodeJS.Platform
  pathEnv: string
  homeDir: string
  /** e.g. %LOCALAPPDATA% on Windows; empty string when unset. */
  localAppData?: string
}

export function realDetectEnvironment(): DetectEnvironment {
  return {
    platform: process.platform,
    pathEnv: process.env['PATH'] ?? '',
    homeDir: process.env[(process.platform === 'win32' ? 'USERPROFILE' : 'HOME')] ?? '',
    localAppData: process.env['LOCALAPPDATA'] ?? '',
  }
}
