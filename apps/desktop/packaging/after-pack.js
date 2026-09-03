// Packaging guard for the pty native module (wired as electron-builder's afterPack).
//
// `@lydell/node-pty` is only a resolver stub: it `require`s
// `@lydell/node-pty-<platform>-<arch>`, which is where the implementation and the
// prebuilt binaries actually live. That package reaches the app as an optional
// dependency, so any regression in electron-builder's dependency collection drops
// it silently — the app still boots, and the terminal opens to a dead blinking
// cursor. Assert the invariant here so the build fails instead of shipping.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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

/** A prebuilt package is only usable if its .node addon sits on the real filesystem. */
function hasNativeAddon(packageDir) {
  const prebuilds = join(packageDir, 'prebuilds')
  if (!existsSync(prebuilds)) return false
  return readdirSync(prebuilds, { recursive: true }).some((it) => String(it).endsWith('.node'))
}

export default async function afterPack(context) {
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
        `Terminal would ship broken for ${platform}/${ARCH_NAMES[context.arch]}:`,
        ...problems.map((it) => `  - ${it}`),
        'Check that the @lydell/node-pty-* optionalDependencies are still declared in',
        'apps/desktop/package.json and that asarUnpack still covers them.',
      ].join('\n'),
    )
  }
}
