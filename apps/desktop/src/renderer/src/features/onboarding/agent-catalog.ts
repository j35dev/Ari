import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { driverLabel } from '../composer/agent-mark'

export type Detection = RpcResults['providers.detect'][number]
export type CliAgent = Exclude<DriverKind, 'ari-core'>

/** The account each agent signs in with, in the words a new user knows. */
const ACCOUNTS: Partial<Record<DriverKind, string>> = {
  claude: 'Your Claude account',
  codex: 'Your ChatGPT account',
  grok: 'Your xAI account',
  opencode: 'Any model provider',
  pi: 'Any model provider',
  qoder: 'Your Qoder account',
  hermes: 'Your Nous account',
  muse: 'Your Meta account',
}

/** Shown when nothing is installed: what each agent needs before it can work. */
export const RECOMMENDED: readonly { kind: CliAgent; needs: string }[] = [
  { kind: 'claude', needs: 'Needs a Claude subscription' },
  { kind: 'codex', needs: 'Works with your ChatGPT plan' },
]

/** Installable agents beyond the two recommended ones, most familiar first. */
export const OTHER_AGENTS: readonly CliAgent[] = ['opencode', 'grok', 'pi', 'qoder']

/** Preference when several agents are ready: the order Ari pre-selects in. */
const PREFERENCE: readonly DriverKind[] = ['claude', 'codex', 'opencode', 'grok', 'pi', 'qoder']

export function agentName(kind: string): string {
  if (kind === 'claude') return 'Claude Code'
  if (kind === 'ari-core') return 'Ari Core'
  return driverLabel(kind)
}

export function agentAccount(kind: string): string {
  return ACCOUNTS[kind as DriverKind] ?? 'Signs in with its own account'
}

/** Installed, switched on and reachable: an agent Ari can start a turn with. */
export function usable(detection: Detection | undefined): detection is Detection {
  return (
    detection !== undefined &&
    detection.kind !== 'ari-core' &&
    detection.installed &&
    detection.enabled !== false &&
    detection.transport?.available !== false
  )
}

export function preferenceOf(kind: string): number {
  const index = PREFERENCE.indexOf(kind as DriverKind)
  return index === -1 ? PREFERENCE.length : index
}

/** Usable agents, signed-in ones first, then by {@link PREFERENCE}. */
export function usableAgents(detections: readonly Detection[] | null): Detection[] {
  return (detections ?? [])
    .filter(usable)
    .sort(
      (a, b) =>
        Number(b.authStatus === 'authenticated') - Number(a.authStatus === 'authenticated') ||
        preferenceOf(a.kind) - preferenceOf(b.kind),
    )
}
