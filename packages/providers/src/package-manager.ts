import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { DriverKind } from '@ari/contracts/common'
import { NPM_PACKAGES } from './updates'

export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'brew' | 'uv' | 'scoop' | 'winget' | 'native'

export interface InstallPlan {
  manager: PackageManager
  installCommand: string[]
  upgradeCommand: string[]
  display: string
}

const MANAGER_MARKERS: { manager: PackageManager; fragments: string[] }[] = [
  { manager: 'scoop', fragments: ['scoop'] },
  { manager: 'winget', fragments: ['winget'] },
  { manager: 'pnpm', fragments: ['pnpm', '.pnpm'] },
  { manager: 'bun', fragments: ['.bun'] },
  { manager: 'brew', fragments: ['cellar', 'caskroom', 'homebrew', 'linuxbrew'] },
  { manager: 'uv', fragments: ['uv', 'uv-tools'] },
  {
    manager: 'npm',
    fragments: ['npm', 'node_modules', 'nvm', '.nvm', 'fnm', '.fnm', 'volta', '.volta'],
  },
]

function paths(path: string) {
  return /^[a-z]:[\\/]|\\\\/i.test(path) ? win32 : posix
}

/** Providers whose vendor ships its own installer, preferred for a first install. */
const VENDOR_INSTALLERS: ReadonlySet<DriverKind> = new Set(['claude', 'grok'])

/** Evidence from the selected install wins over the provider's usual distribution. */
export function inferManager(binaryPath: string | null, kind: DriverKind): PackageManager {
  if (!binaryPath) return VENDOR_INSTALLERS.has(kind) || !NPM_PACKAGES[kind] ? 'native' : 'npm'
  const segments = binaryPath.split(/[\\/]/).map((s) => s.toLowerCase())
  // Pi's managed installer owns a versioned release tree, not npm's global prefix.
  if (kind === 'pi' && /[\\/]\.pi[\\/]agent[\\/](?:bin|install)[\\/]/i.test(binaryPath))
    return 'native'
  for (const { manager, fragments } of MANAGER_MARKERS) {
    if (segments.some((segment) => fragments.includes(segment))) return manager
  }
  return 'native'
}

/** Resolve symlinks and Scoop/WinGet links before choosing a manager. */
function installPath(binaryPath: string | null): string | null {
  if (!binaryPath) return null
  try {
    if (/[\\/]scoop[\\/]shims[\\/]/i.test(binaryPath)) {
      const shim = readFileSync(binaryPath.replace(/\.[^.\\/]+$/, '.shim'), 'utf8')
      const target = /^path\s*=\s*"([^"]+)"/m.exec(shim)?.[1]
      if (target) return target
    }
    return realpathSync(binaryPath)
  } catch {
    return binaryPath
  }
}

function npmPrefix(binaryPath: string): string | null {
  const p = paths(binaryPath)
  const modules = /^(.*?)[\\/]node_modules[\\/]/i.exec(binaryPath)?.[1]
  if (modules) return p.basename(modules) === 'lib' ? p.dirname(modules) : modules
  return /\.(?:cmd|ps1)$/i.test(binaryPath) ? p.dirname(binaryPath) : null
}

function vendorInstaller(url: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Invoke-RestMethod '${url}' | Invoke-Expression`,
      ]
    : ['bash', '-c', `curl -fsSL ${url} | bash`]
}

function nativeCommands(kind: DriverKind, binaryPath: string | null, platform: NodeJS.Platform) {
  const binary = binaryPath ?? (kind === 'qoder' ? 'qodercli' : kind)
  const installer = (unix: string, windows: string) =>
    vendorInstaller(platform === 'win32' ? windows : unix, platform)
  switch (kind) {
    case 'claude':
      return {
        install: installer('https://claude.ai/install.sh', 'https://claude.ai/install.ps1'),
        upgrade: [binary, 'update'],
      }
    case 'opencode':
      return {
        install: ['npm', 'install', '-g', '--ignore-scripts=false', 'opencode-ai'],
        upgrade: [binary, 'upgrade'],
      }
    case 'grok':
      return {
        install: installer('https://x.ai/cli/install.sh', 'https://x.ai/cli/install.ps1'),
        upgrade: [binary, 'update'],
      }
    case 'pi':
      return {
        install: ['npm', 'install', '-g', '--ignore-scripts=false', NPM_PACKAGES.pi!],
        upgrade: [binary, 'update', '--self'],
      }
    case 'hermes':
      return {
        install: installer(
          'https://hermes-agent.nousresearch.com/install.sh',
          'https://hermes-agent.nousresearch.com/install.ps1',
        ),
        upgrade: [binary, 'update'],
      }
    case 'qoder':
      return {
        install: installer('https://qoder.com/install', 'https://qoder.com/install.ps1'),
        upgrade: [binary, 'update'],
      }
    case 'muse': {
      const install = installer('https://dev.meta.ai/install.sh', 'https://dev.meta.ai/install.ps1')
      return { install, upgrade: install }
    }
    default:
      return null
  }
}

/** Select argv for the actual install. Unknown Codex layouts require a manual update. */
export function planFor(
  kind: DriverKind,
  binaryPath: string | null,
  platform: NodeJS.Platform = process.platform,
): InstallPlan | null {
  if (kind === 'ari-core') return null
  const resolved = installPath(binaryPath)
  let manager = inferManager(resolved, kind)
  const pkg = NPM_PACKAGES[kind]
  // A custom npm prefix has no recognizable directory name; its shim and package do.
  if (manager === 'native' && resolved && pkg && /\.(?:cmd|ps1)$/i.test(resolved)) {
    const p = paths(resolved)
    if (existsSync(p.join(p.dirname(resolved), 'node_modules', ...pkg.split('/'), 'package.json')))
      manager = 'npm'
  }
  let commands: { install: string[]; upgrade: string[] } | null = null
  switch (manager) {
    case 'npm':
      if (pkg) {
        // Target the shim's prefix instead of whichever prefix npm happens to use today.
        const root = resolved ? npmPrefix(resolved) : null
        const prefix = root ? ['--prefix', root] : []
        commands = {
          install: ['npm', 'install', '-g', '--ignore-scripts=false', ...prefix, pkg],
          upgrade: ['npm', 'install', '-g', '--ignore-scripts=false', ...prefix, `${pkg}@latest`],
        }
      }
      break
    case 'pnpm':
    case 'bun':
      if (pkg)
        commands = {
          install: [manager, 'add', '-g', pkg],
          upgrade: [manager, 'add', '-g', `${pkg}@latest`],
        }
      break
    case 'brew': {
      const formula = resolved && /[\\/](?:Cellar|Caskroom)[\\/]([^\\/]+)[\\/]/i.exec(resolved)?.[1]
      const name = formula || (kind === 'claude' ? 'claude-code' : kind)
      const cask = resolved && /[\\/]Caskroom[\\/]/i.test(resolved) ? ['--cask'] : []
      commands = {
        install: ['brew', 'install', ...cask, name],
        upgrade: ['brew', 'upgrade', ...cask, name],
      }
      break
    }
    case 'uv':
      if (kind === 'hermes') {
        const tool =
          resolved && /[\\/](?:uv[\\/]tools|uv-tools)[\\/]([^\\/]+)[\\/]/i.exec(resolved)?.[1]
        if (!tool) break
        commands = {
          install: ['uv', 'tool', 'install', tool],
          upgrade: ['uv', 'tool', 'upgrade', tool],
        }
      }
      break
    case 'scoop': {
      const app = resolved && /[\\/]apps[\\/]([^\\/]+)[\\/]/i.exec(resolved)?.[1]
      if (app) commands = { install: ['scoop', 'install', app], upgrade: ['scoop', 'update', app] }
      break
    }
    case 'winget': {
      const id = resolved && /[\\/]Packages[\\/]([^_\\/]+)_[^\\/]+[\\/]/i.exec(resolved)?.[1]
      if (id)
        commands = {
          install: ['winget', 'install', '--id', id, '--exact', '--disable-interactivity'],
          upgrade: ['winget', 'upgrade', '--id', id, '--exact', '--disable-interactivity'],
        }
      break
    }
    case 'native':
      commands = nativeCommands(kind, binaryPath, platform)
      break
  }
  if (!commands) return null
  return {
    manager,
    installCommand: commands.install,
    upgradeCommand: commands.upgrade,
    display: commands.upgrade.join(' '),
  }
}

/** A program an install command needs that may not be on this computer. */
export interface InstallPrerequisite {
  program: string
  /** What the user installs to get it. */
  label: string
  /** Where its official installer lives. */
  url: string
}

const PREREQUISITES: Record<string, Omit<InstallPrerequisite, 'program'>> = {
  npm: { label: 'Node.js', url: 'https://nodejs.org/en/download' },
  pnpm: { label: 'pnpm', url: 'https://pnpm.io/installation' },
  bun: { label: 'Bun', url: 'https://bun.sh' },
  brew: { label: 'Homebrew', url: 'https://brew.sh' },
  uv: { label: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
  scoop: { label: 'Scoop', url: 'https://scoop.sh' },
  winget: { label: 'App Installer', url: 'https://aka.ms/getwinget' },
  curl: { label: 'curl', url: 'https://curl.se/download.html' },
}

/** The first program the command needs that `has` cannot find; null when all are present. */
export function missingPrerequisite(
  argv: readonly string[],
  has: (program: string) => boolean,
): InstallPrerequisite | null {
  const programs = [argv[0] ?? '']
  // `bash -c "curl … | bash"`: the download tool is the one machines lack.
  if (argv[0] === 'bash' && /\bcurl\b/.test(argv.at(-1) ?? '')) programs.push('curl')
  for (const program of programs) {
    const known = PREREQUISITES[program]
    if (known && !has(program)) return { program, ...known }
  }
  return null
}
