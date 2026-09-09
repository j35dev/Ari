// Packaging guard for the pty native module (wired as electron-builder's afterPack).
//
// `@lydell/node-pty` is only a resolver stub: it `require`s
// `@lydell/node-pty-<platform>-<arch>`, which is where the implementation and the
// prebuilt binaries actually live. Those packages are plain `dependencies` rather
// than `optionalDependencies` on purpose: electron-builder platform-filters
// optional deps against the *host*, which silently drops the second slice of a
// universal macOS build (the x64 half on an arm64 runner). The app still boots and
// the terminal opens to a dead blinking cursor. Assert the invariant here so the
// build fails instead of shipping.

import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'
import { URL } from 'node:url'
import { clearTimeout, setTimeout } from 'node:timers'

/** electron-builder's Arch enum, which reaches hooks as a bare ordinal. */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/** Prebuilt pty packages a given target must contain, unpacked. */
function expectedPtyPackages(platform, arch) {
  const archName = ARCH_NAMES[arch]
  // A universal macOS app runs on both silicons and needs both binaries.
  const archNames = archName === 'universal' ? ['x64', 'arm64'] : [archName]
  return archNames.map((it) => `@lydell/node-pty-${platform}-${it}`)
}

function resourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') return join(context.appOutDir, 'resources')
  const appName = context.packager.appInfo.productFilename
  return join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
}

/** Manifest keys a build could need; intersected with cliamp.json at pack time. */
export function cliampTargetKeys(platform, arch) {
  const archName = ARCH_NAMES[arch]
  const archNames = archName === 'universal' ? ['x64', 'arm64'] : [archName]
  return archNames.map((it) => `${platform}-${it}`)
}

/** Binary filename inside a fetched target dir (the Windows zip keeps its DLLs beside it). */
export function cliampBinaryName(targetKey) {
  return targetKey.startsWith('win32') ? 'cliamp.exe' : 'cliamp'
}

/** A prebuilt package is only usable if its .node addon sits on the real filesystem. */
function hasNativeAddon(packageDir) {
  const prebuilds = join(packageDir, 'prebuilds')
  if (!existsSync(prebuilds)) return false
  return readdirSync(prebuilds, { recursive: true }).some((it) => String(it).endsWith('.node'))
}

const ACP_ADAPTERS = Object.entries(
  JSON.parse(readFileSync(new URL('./acp-adapters.json', import.meta.url), 'utf8')),
).map(([kind, adapter]) => ({ kind, ...adapter }))

const ACP_PLATFORM_PACKAGES = {
  claude: '@anthropic-ai/claude-agent-sdk',
  codex: '@openai/codex',
}
const ACP_SHARED_PACKAGES = [
  '@agentclientprotocol/sdk',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
]

const CODEX_TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
}

export function packageDir(nodeModules, packageName) {
  return join(nodeModules, ...packageName.split('/'))
}

export function platformPackageName(kind, platform, arch) {
  const suffix = `${platform}-${arch}`
  return kind === 'claude'
    ? `${ACP_PLATFORM_PACKAGES.claude}-${suffix}`
    : `${ACP_PLATFORM_PACKAGES.codex}-${suffix}`
}

export function expectedAdapterPackages(platform, arch) {
  const archNames = ARCH_NAMES[arch] === 'universal' ? ['x64', 'arm64'] : [ARCH_NAMES[arch]]
  return [
    ...ACP_SHARED_PACKAGES,
    ...ACP_ADAPTERS.flatMap(({ kind, packageName }) => [
      packageName,
      ACP_PLATFORM_PACKAGES[kind],
      ...archNames.map((it) => platformPackageName(kind, platform, it)),
    ]),
  ]
}

/** Native files that prove the platform package is usable, not merely present. */
export function expectedAdapterBinaries(kind, platform, arch) {
  const archName = ARCH_NAMES[arch]
  const archNames = archName === 'universal' ? ['x64', 'arm64'] : [archName]
  return archNames.flatMap((it) => {
    const packageName = platformPackageName(kind, platform, it)
    if (kind === 'claude') {
      return [join(packageName, platform === 'win32' ? 'claude.exe' : 'claude')]
    }
    const target = CODEX_TARGETS[`${platform}-${it}`]
    if (target === undefined) return []
    const executable = platform === 'win32' ? 'codex.exe' : 'codex'
    const helper = platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
    const ripgrep = platform === 'win32' ? 'rg.exe' : 'rg'
    return [
      join(packageName, 'vendor', target, 'bin', executable),
      join(packageName, 'vendor', target, 'bin', helper),
      join(packageName, 'vendor', target, 'codex-path', ripgrep),
    ]
  })
}

/**
 * Starts each locally-built adapter through the exact Electron Node-mode
 * command used at runtime. The initialize reply proves asar unpacking,
 * module resolution, and the platform binary are all usable together.
 */
export async function smokeBundledAdapter(executable, entrypoint, env, cwd, timeoutMs = 15_000) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [entrypoint], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      if (error === undefined) resolve()
      else reject(error)
    }
    const timeout = setTimeout(() => {
      finish(new Error(`initialize response timed out; stderr: ${stderr.slice(-800)}`))
    }, timeoutMs)
    child.stdin.on('error', (error) => finish(error))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 1024 * 1024) {
        finish(new Error('adapter initialize output exceeded 1 MiB'))
        return
      }
      for (const line of stdout.split('\n').slice(0, -1)) {
        try {
          const message = JSON.parse(line)
          if (message?.id === 1) {
            if (message.error !== undefined) {
              finish(new Error(`adapter rejected initialize: ${JSON.stringify(message.error)}`))
            } else if (message.result?.protocolVersion === 1) {
              finish()
            } else {
              finish(new Error('adapter returned an invalid initialize response'))
            }
            return
          }
        } catch {
          // Adapter logs are allowed on stdout during startup; keep scanning.
        }
      }
      stdout = stdout.slice(stdout.lastIndexOf('\n') + 1)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-800)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (!settled)
        finish(
          new Error(
            `adapter exited before initialize (code ${code}); stderr: ${stderr.slice(-800)}`,
          ),
        )
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: 'ari-packaging-smoke', version: '0.0.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            auth: { terminal: false },
            elicitation: { form: {} },
            _meta: { 'terminal-auth': true },
          },
        },
      })}\n`,
    )
  })
}

export default async function afterPack(context) {
  const cli = join(resourcesDir(context), 'agent-cli', 'ari.cjs')
  const skill = join(resourcesDir(context), 'agent-cli', 'ari', 'SKILL.md')
  if (!existsSync(cli) || !existsSync(skill))
    throw new Error('Agent CLI or bundled Ari skill is missing from packaged resources.')
  const unpacked = join(resourcesDir(context), 'app.asar.unpacked', 'node_modules')
  const platform = context.electronPlatformName
  const problems = []

  // These packages are unpacked as a unit so the adapters' provider binaries
  // are spawnable from the Electron Node-mode child process. Other ordinary JS
  // dependencies remain in app.asar and are loaded through Electron's asar
  // module support.
  for (const packageName of expectedAdapterPackages(platform, context.arch)) {
    if (!existsSync(packageDir(unpacked, packageName))) {
      problems.push(`${packageName} is missing from the bundled ACP runtime`)
    }
  }
  for (const { packageName } of ACP_ADAPTERS) {
    if (!existsSync(join(packageDir(unpacked, packageName), 'dist', 'index.js'))) {
      problems.push(`${packageName}/dist/index.js is missing from the bundled ACP runtime`)
    }
  }
  for (const { kind } of ACP_ADAPTERS) {
    for (const relativePath of expectedAdapterBinaries(kind, platform, context.arch)) {
      if (!existsSync(join(unpacked, relativePath))) {
        problems.push(`${relativePath} is missing from the bundled ACP runtime`)
      }
    }
  }

  if (!existsSync(join(unpacked, '@lydell', 'node-pty'))) {
    problems.push('@lydell/node-pty (resolver stub) is not unpacked')
  }
  for (const name of expectedPtyPackages(platform, context.arch)) {
    const dir = join(unpacked, ...name.split('/'))
    if (!existsSync(dir)) problems.push(`${name} is missing from the package`)
    else if (!hasNativeAddon(dir)) problems.push(`${name} has no unpacked .node addon`)
  }

  // Bundled Focus music backend: the pinned Cliamp release must be present
  // for every target this build serves. Targets with no upstream asset
  // (e.g. win32-arm64) warn instead of failing — music degrades there.
  const cliampManifestPath = join(resourcesDir(context), 'cliamp', 'cliamp.json')
  if (!existsSync(cliampManifestPath)) {
    problems.push('cliamp/cliamp.json is missing from packaged resources')
  } else {
    const cliampManifest = JSON.parse(readFileSync(cliampManifestPath, 'utf8'))
    for (const key of cliampTargetKeys(platform, context.arch)) {
      const entry = cliampManifest.targets?.[key]
      if (!entry) {
        process.stderr.write(
          `after-pack: no pinned Cliamp asset for ${key}; music degrades on that target\n`,
        )
        continue
      }
      const binary = join(
        resourcesDir(context),
        'cliamp',
        'bin',
        key,
        entry.binary ?? cliampBinaryName(key),
      )
      if (!existsSync(binary)) {
        problems.push(`${key} Cliamp binary is missing (run scripts/fetch-cliamp.mjs)`)
        continue
      }
      if (platform !== 'win32') {
        try {
          accessSync(binary, constants.X_OK)
        } catch {
          problems.push(`${key} Cliamp binary is not executable`)
        }
      }
      // A foreign-arch binary cannot run here; version-check only the host match.
      if (key === `${process.platform}-${process.arch}` && platform === process.platform) {
        const { stdout } = await promisify(execFile)(binary, ['--version'], {
          windowsHide: true,
          timeout: 15_000,
        })
        if (!stdout.includes(cliampManifest.version)) {
          problems.push(
            `${key} Cliamp reports ${stdout.trim()} but cliamp.json pins ${cliampManifest.version}`,
          )
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        `Packaged runtime is incomplete for ${platform}/${ARCH_NAMES[context.arch]}:`,
        ...problems.map((it) => `  - ${it}`),
        'Check apps/desktop/package.json, pnpm supportedArchitectures, and asarUnpack',
        'for the adapter/runtime packages. For the terminal, also check the @lydell/node-pty',
        'entries and unpack rules.',
      ].join('\n'),
    )
  }
  if (process.platform === platform && ARCH_NAMES[context.arch] === process.arch) {
    const product = context.packager.appInfo.productFilename
    const executable =
      platform === 'darwin'
        ? join(context.appOutDir, `${product}.app`, 'Contents', 'MacOS', product)
        : join(context.appOutDir, platform === 'win32' ? `${product}.exe` : 'ari')
    const { stdout } = await promisify(execFile)(executable, [cli, '--skill'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      timeout: 15_000,
    })
    if (!stdout.includes('protocol-version:'))
      throw new Error('Packaged Ari CLI did not return its versioned skill.')

    const moduleRoots = [unpacked, join(resourcesDir(context), 'app.asar', 'node_modules')]
    for (const { packageName, entrypoint } of ACP_ADAPTERS) {
      const adapterEntrypoint = join(packageDir(unpacked, packageName), entrypoint)
      const smokeEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: moduleRoots.join(process.platform === 'win32' ? ';' : ':'),
      }
      delete smokeEnv.CODEX_PATH
      delete smokeEnv.CLAUDE_CODE_EXECUTABLE
      try {
        await smokeBundledAdapter(executable, adapterEntrypoint, smokeEnv, context.appOutDir)
      } catch (error) {
        throw new Error(
          `${packageName} packaged startup smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
  }
}
