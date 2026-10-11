import type { DriverKind } from '@ari/contracts/common'
import { cliKindSchema } from '@ari/contracts/settings'
import type { Settings } from '@ari/contracts/settings'
import { describeTransport } from '@ari/providers/acp/launches'
import { detectDriver } from '@ari/providers/detector'
import type { DetectEnvironment, Detection, ProviderTransport } from '@ari/providers/types'

const LABELS: Record<DriverKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  pi: 'Pi',
  hermes: 'Hermes',
  'ari-core': 'Ari Core',
}

/**
 * Detects one provider the way the user set it up: turned off, pinned to a
 * path, or found on PATH. Everything in the main process that needs a
 * provider's binary goes through here, so a setting cannot be honoured by the
 * settings page and ignored by a model probe or a turn.
 */
export async function detectConnection(
  kind: DriverKind,
  env: DetectEnvironment,
  connections: Settings['providers'],
  detect: typeof detectDriver = detectDriver,
  describe: (kind: DriverKind, binaryPath: string) => ProviderTransport = describeTransport,
): Promise<Detection> {
  const cli = cliKindSchema.safeParse(kind)
  const detection = await detect(kind, env, cli.success ? connections[cli.data] : {})
  if (detection.binaryPath === null) return detection
  // Described against the process environment, as the launch itself resolves.
  return { ...detection, transport: describe(kind, detection.binaryPath) }
}

/**
 * Why a turn on this provider cannot start, worded for the transcript, or null
 * when detection has nothing against it. `enabled` is the stored setting: it
 * is known at once, where the detection that would say the same may be
 * seconds away.
 */
export function unavailableReason(
  kind: DriverKind,
  detection: Detection | undefined,
  enabled = true,
): string | null {
  const name = LABELS[kind]
  if (!enabled || detection?.enabled === false) {
    return `${name} is turned off. Turn it on in Settings > Providers to use this session.`
  }
  if (detection === undefined || detection.binaryPath !== null) return null
  if (detection.pathProblem !== undefined) {
    return `${name} cannot start from the path set in Settings > Providers: ${detection.pathProblem}`
  }
  return `${name} is not installed. Install it or set its path in Settings > Providers.`
}
