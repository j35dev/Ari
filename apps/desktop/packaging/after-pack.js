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

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'

/** electron-builder's Arch enum, which reaches hooks as a bare ordinal. */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/** Prebuilt pty packages a given target must contain, unpacked. */
export function expectedPtyPackages(platform, arch) {
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

/** A prebuilt package is only usable if its .node addon sits on the real filesystem. */
function hasNativeAddon(packageDir) {
  const prebuilds = join(packageDir, 'prebuilds')
  if (!existsSync(prebuilds)) return false
  return readdirSync(prebuilds, { recursive: true }).some((it) => String(it).endsWith('.node'))
}

export default async function afterPack(context) {
  const cli = join(resourcesDir(context), 'agent-cli', 'ari.cjs')
  const skill = join(resourcesDir(context), 'agent-cli', 'ari', 'SKILL.md')
  if (!existsSync(cli) || !existsSync(skill))
    throw new Error('Agent CLI or bundled Ari skill is missing from packaged resources.')
  const unpacked = join(resourcesDir(context), 'app.asar.unpacked', 'node_modules')
  const platform = context.electronPlatformName
  const problems = []

  if (!existsSync(join(unpacked, '@lydell', 'node-pty'))) {
    problems.push('@lydell/node-pty (resolver stub) is not unpacked')
  }
  for (const name of expectedPtyPackages(platform, context.arch)) {
    const dir = join(unpacked, ...name.split('/'))
    if (!existsSync(dir)) problems.push(`${name} is missing from the package`)
    else if (!hasNativeAddon(dir)) problems.push(`${name} has no unpacked .node addon`)
  }

  if (problems.length > 0) {
    throw new Error(
      [
        `Packaged runtime is incomplete for ${platform}/${ARCH_NAMES[context.arch]}:`,
        ...problems.map((it) => `  - ${it}`),
        'Check the @lydell/node-pty entries and asarUnpack rules in',
        'apps/desktop/electron-builder.yml.',
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
  }
}
