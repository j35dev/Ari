import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { wellKnownDirs } from '../detector'
import type { AcpLaunch } from './connection'
import type { DetectEnvironment } from '../types'
import { realDetectEnvironment } from '../types'

const log = createLogger('providers:acp')

/**
 * Per-kind ACP transports (M16). Agents with native ACP servers are launched
 * directly; Node-only agents ride the official stdio adapters through npx.
 * Every launch degrades gracefully: when {@link resolveAcpLaunch} returns
 * null the registry falls back to the legacy one-shot CLI drivers.
 *
 * Sources: agentclientprotocol.com agents index; opencode docs (`opencode
 * acp`); hermes docs (`hermes acp`); xAI Grok Build (`grok agent stdio`);
 * @agentclientprotocol/* adapter packages on npm.
 */

/** Official npx-distributed ACP adapters requiring their CLI installed too. */
const NPM_ADAPTERS: Partial<Record<DriverKind, string>> = {
  claude: '@agentclientprotocol/claude-agent-acp',
  codex: '@agentclientprotocol/codex-acp',
  pi: 'pi-acp',
}

/** Kinds whose own binary speaks ACP given these arguments. */
const NATIVE_ACP_ARGS: Partial<Record<DriverKind, string[]>> = {
  opencode: ['acp'],
  hermes: ['acp'],
  grok: ['agent', 'stdio'],
}

/**
 * Resolves the npx launcher across PATH plus npm's usual global dirs. Kept
 * separate from findBinary because `npx` is infrastructure, not a provider.
 */
export function findNpxCommand(env: DetectEnvironment): string | null {
  const names =
    env.platform === 'win32' ? (['npx.cmd', 'npx.exe', 'npx'] as const) : (['npx'] as const)
  const dirs = [
    ...env.pathEnv.split(delimiter).filter((p) => p.length > 0),
    ...wellKnownDirs(env),
  ]
  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return join(dir, name)
    }
  }
  return null
}

export interface ResolveAcpLaunchOptions {
  /** Detection result for the kind's own CLI (null = not installed). */
  cliBinaryPath: string | null
  /** Set ARI_ACP=0 or ARI_ACP_<KIND>=0 to pin a kind onto its legacy driver. */
  envOverride?: string | null
}

/**
 * Returns the ACP launch for a kind, or null when the transport is disabled,
 * unavailable, or its prerequisite CLI is missing.
 */
export function resolveAcpLaunch(
  kind: DriverKind,
  options: ResolveAcpLaunchOptions,
  detectEnv: DetectEnvironment = realDetectEnvironment(),
): AcpLaunch | null {
  if (process.env['ARI_ACP'] === '0' || options.envOverride === '0') return null
  if (options.cliBinaryPath === null) return null

  const adapterPkg = NPM_ADAPTERS[kind]
  if (adapterPkg !== undefined) {
    const npx = findNpxCommand(detectEnv)
    if (npx === null) {
      log.debug('acp: npx not found; using legacy driver', { kind })
      return null
    }
    return { label: `${kind} (ACP adapter ${adapterPkg})`, command: npx, args: ['-y', adapterPkg] }
  }

  const args = NATIVE_ACP_ARGS[kind]
  if (args !== undefined) {
    return { label: `${kind} (native ACP)`, command: options.cliBinaryPath, args }
  }
  return null
}
