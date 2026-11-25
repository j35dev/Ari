// Writes THIRD_PARTY_NOTICES.txt: the license of every third-party package
// that ships inside Ari. Run before each release:
//
//   node scripts/third-party-notices.mjs
//
// What ships:
// - the desktop app's `dependencies`, which electron-builder copies into the
//   package with their own dependencies;
// - libraries bundled into out/main and out/renderer: the desktop
//   devDependencies that are runtime code (not build tools), and everything
//   the @ari/* workspace packages depend on;
// - the phone PWA's dependencies (resources/mobile).
// Each package is found the way Node would resolve it from its parent, so
// pnpm's layout is followed exactly. Platform packages that are not installed
// on the machine running this script are listed at the end without text.
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const OUTPUT = join(ROOT, 'THIRD_PARTY_NOTICES.txt')

/** desktop devDependencies that build the app and never reach it. */
const BUILD_ONLY = new Set([
  '@tailwindcss/postcss',
  '@vitejs/plugin-react',
  'electron',
  'electron-builder',
  'electron-vite',
  'magic-string',
  'vite',
])

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-_.].*)?$/i

/** License and notice files in a package directory, in a stable order. */
export function licenseFiles(names) {
  return names.filter((name) => LICENSE_FILE.test(name)).sort()
}

/** The license a package.json declares, in any of its historical shapes. */
export function declaredLicense(manifest) {
  const { license, licenses } = manifest
  if (typeof license === 'string') return license
  if (license && typeof license.type === 'string') return license.type
  if (Array.isArray(licenses))
    return licenses.map((entry) => (typeof entry === 'string' ? entry : entry.type)).join(' OR ')
  return 'UNKNOWN'
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Node's lookup: the nearest node_modules/<name> at or above `from`. */
function locate(name, from) {
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isWorkspace(name) {
  return name.startsWith('@ari/')
}

/** Every third-party package reachable from the roots, keyed by name@version. */
export function collect(roots) {
  const found = new Map()
  const missing = new Set()
  const seenDirs = new Set()
  const queue = roots.map(({ name, from, bundled }) => ({ name, from, bundled, optional: false }))
  while (queue.length > 0) {
    const { name, from, bundled, optional } = queue.shift()
    const dir = locate(name, from)
    if (dir === null) {
      if (!optional) missing.add(name)
      continue
    }
    // A package reached both bundled and shipped is walked once as each.
    const seen = `${bundled ? 'bundled' : 'shipped'}:${dir}`
    if (seenDirs.has(seen)) continue
    seenDirs.add(seen)
    const manifest = readJson(join(dir, 'package.json'))
    if (!isWorkspace(name)) {
      const files = licenseFiles(readdirSync(dir))
      found.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version,
        license: declaredLicense(manifest),
        homepage:
          manifest.homepage ??
          (typeof manifest.repository === 'string'
            ? manifest.repository
            : manifest.repository?.url) ??
          null,
        texts: files.map((file) =>
          readFileSync(join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim(),
        ),
      })
    }
    for (const dep of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dep, from: dir, bundled, optional: false })
    // Installed peers are what the package actually loads.
    for (const dep of Object.keys(manifest.peerDependencies ?? {}))
      queue.push({ name: dep, from: dir, bundled, optional: true })
    // Optional platform binaries ship only with node_modules packages: a
    // bundler inlines JavaScript, not the executables a package might spawn.
    if (!bundled)
      for (const dep of Object.keys(manifest.optionalDependencies ?? {}))
        queue.push({ name: dep, from: dir, bundled, optional: true })
  }
  for (const entry of found.values()) missing.delete(entry.name)
  return { packages: [...found.values()], missing: [...missing].sort() }
}

/**
 * The notices file. Packages that carry the very same license text share one
 * copy of it, which keeps hundreds of identical MIT texts from repeating.
 */
export function render({ packages, missing }) {
  const byText = new Map()
  const textless = []
  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) {
    if (pkg.texts.length === 0) {
      textless.push(pkg)
      continue
    }
    const key = pkg.texts.join('\n\n')
    const group = byText.get(key) ?? []
    group.push(pkg)
    byText.set(key, group)
  }
  const line = '-'.repeat(78)
  const label = (pkg) =>
    `${pkg.name}@${pkg.version} (${pkg.license})${pkg.homepage ? ` ${pkg.homepage}` : ''}`
  const out = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Ari includes the third-party software listed below. Each package is',
    'distributed under its own license, reproduced here. Electron and Chromium',
    'license notices ship next to the Ari executable (LICENSE, LICENSES.chromium.html).',
    '',
    'Generated by scripts/third-party-notices.mjs.',
    '',
  ]
  for (const [text, group] of byText) {
    out.push(line, ...group.map(label), line, '', text, '')
  }
  if (textless.length > 0) {
    out.push(line, 'Packages that ship no license file (declared license shown):', line, '')
    out.push(...textless.map(label), '')
  }
  if (missing.length > 0) {
    out.push(line, 'Not installed where this file was generated (other platforms):', line, '')
    out.push(...missing, '')
  }
  return `${out.join('\n')}\n`
}

/** The packages Ari ships, as resolution roots. */
export function shippedRoots(root = ROOT) {
  const desktopDir = join(root, 'apps', 'desktop')
  const mobileDir = join(root, 'apps', 'mobile')
  const desktop = readJson(join(desktopDir, 'package.json'))
  const mobile = readJson(join(mobileDir, 'package.json'))
  const roots = [
    ...Object.keys(desktop.dependencies ?? {}).map((name) => ({
      name,
      from: desktopDir,
      bundled: false,
    })),
    ...Object.keys(desktop.devDependencies ?? {})
      .filter((name) => !BUILD_ONLY.has(name) && !name.startsWith('@types/'))
      .map((name) => ({ name, from: desktopDir, bundled: true })),
    ...Object.keys(mobile.dependencies ?? {}).map((name) => ({
      name,
      from: mobileDir,
      bundled: true,
    })),
  ]
  return roots
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = collect(shippedRoots())
  writeFileSync(OUTPUT, render(result))
  console.log(
    `Wrote ${OUTPUT}: ${result.packages.length} packages` +
      (result.missing.length > 0 ? `, ${result.missing.length} not installed here` : ''),
  )
}
