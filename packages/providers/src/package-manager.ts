import type { DriverKind } from '@ari/contracts/common'
import { NPM_PACKAGES } from './updates'

/** Channel a CLI was installed through, inferred from its resolved path. */
export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'brew' | 'uv' | 'native'

export interface InstallPlan {
  manager: PackageManager
  /** argv array — never a shell string, so no path or version can be injected. */
  installCommand: string[]
  upgradeCommand: string[]
  /** Human-readable one-liner for the confirm dialog. */
  display: string
}

/**
 * Kinds distributed outside any package manager, with their own updater.
 * `grok` ships via the x.ai install script, `hermes` via PowerShell/uv.
 */
const NATIVE_SELF_UPGRADE: Partial<Record<DriverKind, string[]>> = {
  grok: ['grok', 'update'],
  hermes: ['hermes', 'update'],
}

const NATIVE_INSTALL: Partial<Record<DriverKind, string[]>> = {
  // Documented vendor installers; run as argv, never through a shell.
  grok: ['sh', '-c', 'curl -fsSL https://x.ai/cli/install.sh | sh'],
  hermes: ['uv', 'tool', 'install', 'hermes-cli'],
}

/** Path fragments that identify each global package-manager install root. */
const MANAGER_MARKERS: { manager: PackageManager; fragments: string[] }[] = [
  { manager: 'pnpm', fragments: ['pnpm', '.pnpm'] },
  { manager: 'bun', fragments: ['.bun'] },
  { manager: 'brew', fragments: ['cellar', 'homebrew', 'linuxbrew'] },
  { manager: 'uv', fragments: ['uv', 'uv-tools'] },
  { manager: 'npm', fragments: ['npm', 'node_modules', 'nvm', 'fnm', 'volta'] },
]

/** Splits a path on both separators so win32 fixtures work under POSIX tests. */
function pathSegments(binaryPath: string): string[] {
  return binaryPath.split(/[\\/]/).filter((s) => s.length > 0)
}

/**
 * Infers the install channel from a resolved binary path. Unknown layouts
 * fall back to `'native'` rather than guessing a package manager that would
 * then be invoked with the wrong package name.
 */
export function inferManager(binaryPath: string | null, kind: DriverKind): PackageManager {
  if (kind in NATIVE_SELF_UPGRADE) return 'native'
  if (!binaryPath) return NPM_PACKAGES[kind] ? 'npm' : 'native'
  const segments = pathSegments(binaryPath).map((s) => s.toLowerCase())
  for (const { manager, fragments } of MANAGER_MARKERS) {
    if (segments.some((segment) => fragments.includes(segment))) return manager
  }
  return NPM_PACKAGES[kind] ? 'npm' : 'native'
}

function globalCommands(manager: PackageManager, pkg: string): { install: string[]; upgrade: string[] } | null {
  switch (manager) {
    case 'npm':
      // npm 10+ can skip lifecycle scripts by default and still exit 0, which
      // leaves CLIs like Claude Code on a stub binary. Allow this package's
      // scripts so the postinstall actually lands (T3 parity).
      return {
        install: ['npm', 'install', '-g', `--allow-scripts=${pkg}`, pkg],
        upgrade: ['npm', 'install', '-g', `--allow-scripts=${pkg}`, `${pkg}@latest`],
      }
    case 'pnpm':
      return { install: ['pnpm', 'add', '-g', pkg], upgrade: ['pnpm', 'add', '-g', `${pkg}@latest`] }
    case 'bun':
      return { install: ['bun', 'add', '-g', pkg], upgrade: ['bun', 'add', '-g', `${pkg}@latest`] }
    case 'brew':
      // Homebrew formula names never carry an npm scope.
      return {
        install: ['brew', 'install', brewFormula(pkg)],
        upgrade: ['brew', 'upgrade', brewFormula(pkg)],
      }
    case 'uv':
      return { install: ['uv', 'tool', 'install', pkg], upgrade: ['uv', 'tool', 'upgrade', pkg] }
    case 'native':
      return null
  }
}

/** `@scope/name` → `name`; unscoped names pass through. */
function brewFormula(pkg: string): string {
  const slash = pkg.lastIndexOf('/')
  return slash === -1 ? pkg : pkg.slice(slash + 1)
}

/**
 * Maps a resolved binary path + kind to the exact argv Ari would run to
 * install or upgrade that CLI. Pure: no filesystem or process access, so the
 * confirm dialog can display the literal command before anything executes.
 */
export function planFor(kind: DriverKind, binaryPath: string | null): InstallPlan | null {
  if (kind === 'ari-core') return null
  const manager = inferManager(binaryPath, kind)
  const pkg = NPM_PACKAGES[kind]
  if (manager !== 'native' && pkg) {
    const commands = globalCommands(manager, pkg)
    if (commands) {
      return {
        manager,
        installCommand: commands.install,
        upgradeCommand: commands.upgrade,
        display: commands.upgrade.join(' '),
      }
    }
  }
  const install = NATIVE_INSTALL[kind]
  const upgrade = NATIVE_SELF_UPGRADE[kind]
  if (!install || !upgrade) return null
  return { manager: 'native', installCommand: install, upgradeCommand: upgrade, display: upgrade.join(' ') }
}
