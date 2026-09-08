import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import { wellKnownDirs } from '../detector'
import type { AcpLaunch } from './connection'
import type { DetectEnvironment } from '../types'
import { realDetectEnvironment } from '../types'
import adapterManifest from '../../../../apps/desktop/packaging/acp-adapters.json'

const log = createLogger('providers:acp')

/**
 * Per-kind ACP transports (M16). Agents with native ACP servers are launched
 * directly; packaged Ari launches the Claude and Codex stdio adapters through
 * Electron's embedded Node runtime, while development installs ride npx.
 * Every launch degrades gracefully: when {@link resolveAcpLaunch} returns
 * null the registry falls back to the legacy one-shot CLI drivers.
 *
 * Sources: agentclientprotocol.com agents index; opencode docs (`opencode
 * acp`); hermes docs (`hermes acp`); xAI Grok Build (`grok agent stdio`);
 * @agentclientprotocol/* adapter packages on npm.
 */

/** Official ACP adapters and their development-time npx package names. */
const NPM_ADAPTERS: Partial<Record<DriverKind, string>> = Object.fromEntries(
  Object.entries(adapterManifest).map(([kind, adapter]) => [kind, adapter.packageName]),
)

const ACP_ADAPTER_VERSIONS: Partial<Record<DriverKind, string>> = Object.fromEntries(
  Object.entries(adapterManifest).map(([kind, adapter]) => [kind, adapter.version]),
)

const BUNDLED_ADAPTERS: Partial<
  Record<DriverKind, { packageName: string; entrypoint: string }>
> = Object.fromEntries(
  Object.entries(adapterManifest).map(([kind, adapter]) => [kind, {
    packageName: adapter.packageName,
    entrypoint: adapter.entrypoint,
  }]),
)

/* pi-acp remains a development-only adapter and is intentionally not packaged. */
Object.assign(NPM_ADAPTERS, {
  pi: 'pi-acp',
})

/**
 * The packaged adapter manifest is the pin source. Unpinned `npx -y <pkg>` resolved
 * whatever published that day, which made ACP failures unreproducible between two users on the
 * same Ari build and let protocol details Ari depends on — `terminal-auth` is
 * an adapter `_meta` extension, not standard ACP — change underneath a release.
 * Every bump is a deliberate commit, verified against the login handshake.
 *
 * Override per kind with `ARI_ACP_ADAPTER_<KIND>` (a version, a full spec, or
 * `latest`) to test a new adapter without a rebuild.
 */
Object.assign(ACP_ADAPTER_VERSIONS, { pi: '0.0.33' })

/**
 * The npx spec for a kind's adapter: the pinned `pkg@version`, or whatever
 * `ARI_ACP_ADAPTER_<KIND>` names. A bare override value is read as a version
 * (`0.71.0`, `latest`); one containing `/` or a trailing `@` part is taken as a
 * complete spec so a fork or tarball URL can be dropped in whole.
 */
export function acpAdapterSpec(
  kind: DriverKind,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const pkg = NPM_ADAPTERS[kind]
  if (pkg === undefined) return null
  const override = env[`ARI_ACP_ADAPTER_${kind.toUpperCase()}`]?.trim()
  if (override !== undefined && override.length > 0) {
    const isFullSpec = override.includes('/') || override.lastIndexOf('@') > 0
    return isFullSpec ? override : `${pkg}@${override}`
  }
  const version = ACP_ADAPTER_VERSIONS[kind]
  return version === undefined ? pkg : `${pkg}@${version}`
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
  /**
   * Packaged adapter runtime. When present, Claude/Codex use the shipped JS
   * entrypoint and this Electron executable instead of npx.
   */
  bundledRuntime?: BundledAcpRuntime
}

export interface BundledAcpRuntime {
  /** Electron executable launched with ELECTRON_RUN_AS_NODE=1. */
  executable: string
  /** Physical node modules directory inside app.asar.unpacked. */
  nodeModulesDir: string
  /** Asar and unpacked module roots needed by Node's bare-specifier resolver. */
  modulePaths?: string[]
}

function bundledAdapterEntry(kind: DriverKind, runtime: BundledAcpRuntime): string | null {
  const adapter = BUNDLED_ADAPTERS[kind]
  if (adapter === undefined) return null
  return join(runtime.nodeModulesDir, adapter.packageName, adapter.entrypoint)
}

/**
 * Turns a launch into one safe for background probing: model lists and login
 * preflights must read the harness the user already has, never fetch it.
 *
 * `--no-install` alone does that, but npx resolves consent last-wins, so
 * `npx --no-install -y <pkg>` downloads anyway — verified against npm 11, where
 * `npx --no-install cowsay@1.5.0` refuses with "npx canceled due to missing
 * packages and no YES option" while the same line plus `-y` installs and runs
 * it. The consent flag has to come *out* for the guard to mean anything.
 */
export function probeLaunch(launch: AcpLaunch): AcpLaunch {
  if (launch.viaNpx !== true) return launch
  const args = launch.args.filter((arg) => arg !== '-y' && arg !== '--yes')
  return { ...launch, args: ['--no-install', ...args] }
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
  const override = options.envOverride ?? process.env[`ARI_ACP_${kind.toUpperCase()}`] ?? null
  if (process.env['ARI_ACP'] === '0' || override === '0') return null
  if (options.cliBinaryPath === null) return null

  const adapterPkg = NPM_ADAPTERS[kind]
  if (adapterPkg !== undefined) {
    // An explicit adapter override deliberately opts out of the shipped
    // adapter, preserving the existing npx/fork testing escape hatch.
    const adapterOverride = process.env[`ARI_ACP_ADAPTER_${kind.toUpperCase()}`]?.trim()
    const bundledEntry =
      adapterOverride === undefined || adapterOverride.length === 0
        ? options.bundledRuntime === undefined
          ? null
          : bundledAdapterEntry(kind, options.bundledRuntime)
        : null
    if (bundledEntry !== null) {
      if (!existsSync(bundledEntry)) {
        log.warn('acp: bundled adapter entrypoint is missing; using legacy fallback', {
          kind,
          entrypoint: bundledEntry,
        })
        return null
      }
      const adapter = BUNDLED_ADAPTERS[kind]
      const runtime = options.bundledRuntime
      if (adapter === undefined || runtime === undefined) return null
      const launch: AcpLaunch = {
        label: `${kind} (bundled ACP adapter ${adapter.packageName})`,
        command: runtime.executable,
        args: [bundledEntry],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          ...(runtime.modulePaths === undefined
            ? {}
            : { NODE_PATH: runtime.modulePaths.join(delimiter) }),
        },
        viaBundled: true,
        // Otherwise codex-acp runs its bundled Codex, which can lag the user's CLI.
        ...(kind === 'codex'
          ? {
              env: {
                ELECTRON_RUN_AS_NODE: '1',
                ...(runtime.modulePaths === undefined
                  ? {}
                  : { NODE_PATH: runtime.modulePaths.join(delimiter) }),
                CODEX_PATH: options.cliBinaryPath,
              },
            }
          : {}),
      }
      return launch
    }
    const npx = findNpxCommand(detectEnv)
    if (npx === null) {
      log.debug('acp: npx not found; using legacy driver', { kind })
      return null
    }
    const spec = acpAdapterSpec(kind) ?? adapterPkg
    return {
      label: `${kind} (ACP adapter ${spec})`,
      command: npx,
      args: ['-y', spec],
      viaNpx: true,
      // Otherwise codex-acp runs its bundled Codex, which can lag the user's CLI.
      ...(kind === 'codex' ? { env: { CODEX_PATH: options.cliBinaryPath } } : {}),
    }
  }

  const args = NATIVE_ACP_ARGS[kind]
  if (args !== undefined) {
    return { label: `${kind} (native ACP)`, command: options.cliBinaryPath, args }
  }
  return null
}
