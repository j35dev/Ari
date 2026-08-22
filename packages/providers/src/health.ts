import type { DriverKind } from '@ari/contracts/common'

export interface HealthReport {
  kind: DriverKind
  ok: boolean
  latencyMs: number
  version: string | null
  problems: string[]
}

/** Runs `--version` against a binary; injectable for tests. */
export type VersionProber = (
  binaryPath: string,
) => Promise<{ version: string | null; latencyMs: number }>

const realProber: VersionProber = async (binaryPath) => {
  const { execFile } = await import('node:child_process')
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ['--version'],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        const latencyMs = Date.now() - started
        if (error && !stdout) {
          resolve({ version: null, latencyMs })
          return
        }
        resolve({ version: stdout.split('\n')[0]?.trim() ?? null, latencyMs })
      },
    )
  })
}

/**
 * Probes one driver's health: presence, responsiveness, and version.
 * Problems accumulate human-readable diagnostics for the UI.
 */
export async function probeHealth(
  kind: DriverKind,
  binaryPath: string | null,
  runProbe: VersionProber = realProber,
): Promise<HealthReport> {
  const problems: string[] = []
  if (!binaryPath) {
    return {
      kind,
      ok: false,
      latencyMs: 0,
      version: null,
      problems: ['binary not found'],
    }
  }

  const { version, latencyMs } = await runProbe(binaryPath)
  if (version === null) problems.push('version probe failed')
  if (latencyMs > 2000) problems.push(`slow response >2000ms`)

  return { kind, ok: problems.length === 0, latencyMs, version, problems }
}
