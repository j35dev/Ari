import { runCaptured } from '@ari/providers/off-thread'
import { planFor } from '@ari/providers/package-manager'
import { parseVersionToken } from '@ari/providers/updates'
import type { Detection } from '@ari/providers/types'

/** These flags only check; never call a mutating updater to discover a version. */
export function nativeCheckCommand(detection: Detection): string[] | null {
  if (!detection.binaryPath || planFor(detection.kind, detection.binaryPath)?.manager !== 'native')
    return null
  if (detection.kind === 'grok') return [detection.binaryPath, 'update', '--check', '--json']
  if (detection.kind === 'qoder') return [detection.binaryPath, 'update', '--check']
  return null
}

export function parseNativeLatest(detection: Detection, output: string): string | null {
  if (detection.kind === 'grok') {
    try {
      const result = JSON.parse(output.trim()) as { latestVersion?: unknown; error?: unknown }
      return !result.error && typeof result.latestVersion === 'string'
        ? parseVersionToken(result.latestVersion)
        : null
    } catch {
      return null
    }
  }
  const next = /(?:->|→)\s*(v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?)/.exec(output)?.[1]
  if (next) return parseVersionToken(next)
  if (/up.to.date|already.*latest|latest.*installed/i.test(output))
    return parseVersionToken(detection.version)
  return null
}

/**
 * Runs the native updater's check off the main thread: starting grok.exe or
 * qodercli.exe blocks the starting thread for seconds on Windows.
 */
export async function checkNativeLatest(
  detection: Detection,
  env: NodeJS.ProcessEnv,
): Promise<string | null | undefined> {
  const command = nativeCheckCommand(detection)
  if (!command) return undefined
  const [file, ...args] = command
  const result = await runCaptured(file!, args, { env, timeoutMs: 15_000 })
  return result?.code === 0 ? parseNativeLatest(detection, result.stdout ?? '') : null
}
