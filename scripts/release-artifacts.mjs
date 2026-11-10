import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { archivePath, launchArches, sha256, smoke } from './release-native-smoke.mjs'

// Use the packaging tool's existing YAML parser; no runtime dependency is added.
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'))
const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'))
const yaml = packagingRequire('js-yaml')

async function fileReceipt(root, name) {
  const path = join(root, name)
  const info = await stat(path)
  assert.ok(info.isFile() && info.size > 0, `Missing or empty artifact: ${name}`)
  const hash256 = createHash('sha256')
  const hash512 = createHash('sha512')
  for await (const bytes of createReadStream(path)) {
    hash256.update(bytes)
    hash512.update(bytes)
  }
  return { name, bytes: info.size, sha256: hash256.digest('hex'), sha512: hash512.digest('base64') }
}

export async function verifyArtifacts(root, platform, version) {
  const plans = {
    win32: {
      installers: [`Ari-Setup-${version}.exe`],
      maps: [`Ari-Setup-${version}.exe.blockmap`],
      metadata: 'latest.yml',
      update: `Ari-Setup-${version}.exe`,
    },
    darwin: {
      installers: [`Ari-${version}-universal.dmg`, `Ari-${version}-universal.zip`],
      maps: [`Ari-${version}-universal.dmg.blockmap`, `Ari-${version}-universal.zip.blockmap`],
      metadata: 'latest-mac.yml',
      update: `Ari-${version}-universal.zip`,
    },
    linux: {
      installers: [`Ari-${version}.AppImage`, `Ari-${version}.deb`],
      maps: [],
      metadata: 'latest-linux.yml',
      update: `Ari-${version}.AppImage`,
    },
  }
  const plan = plans[platform]
  assert.ok(plan, 'Unsupported release platform')
  const files = await Promise.all(
    [...plan.installers, ...plan.maps, plan.metadata].map((name) => fileReceipt(root, name)),
  )
  const metadata = yaml.load(await readFile(join(root, plan.metadata), 'utf8'))
  assert.equal(metadata.version, version, 'Update metadata version mismatch')
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0, 'Missing update files')
  const seen = new Set()
  for (const entry of metadata.files) {
    assert.equal(typeof entry.url, 'string', 'Missing update URL')
    assert.ok(
      plan.installers.includes(entry.url),
      'Update URL must name an expected local artifact',
    )
    assert.equal(basename(entry.url), entry.url, 'Update URL escaped the artifact directory')
    assert.ok(!seen.has(entry.url), 'Duplicate update artifact')
    seen.add(entry.url)
    const file = files.find((file) => file.name === entry.url)
    assert.equal(entry.size, file.bytes, `Update size mismatch: ${entry.url}`)
    assert.equal(entry.sha512, file.sha512, `Update checksum mismatch: ${entry.url}`)
  }
  assert.ok(seen.has(plan.update), 'Updater artifact missing from metadata')
  if (metadata.path !== undefined) {
    assert.ok(plan.installers.includes(metadata.path), 'Legacy updater path is not an artifact')
    const file = files.find((file) => file.name === metadata.path)
    assert.equal(metadata.sha512, file.sha512, 'Legacy updater checksum mismatch')
  }
  return { platform, version, files, metadata: plan.metadata }
}

async function main() {
  const root = resolve('dist')
  const version = JSON.parse(await readFile('apps/desktop/package.json', 'utf8')).version
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
  assert.match(
    process.env.CANDIDATE_SHA ?? '',
    /^[a-f0-9]{40}$/i,
    'An exact candidate SHA is required',
  )
  assert.equal(sourceHead, process.env.CANDIDATE_SHA, 'Checkout differs from candidate SHA')
  const receipt = {
    sourceHead,
    ...(await verifyArtifacts(root, process.platform, version)),
    native: [],
  }
  const app =
    process.platform === 'darwin' ? join(root, 'mac-universal', 'ari.app', 'Contents') : null
  const output = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'
  const resources = app ? join(app, 'Resources') : join(root, output, 'resources')
  const executable = app
    ? join(app, 'MacOS', 'ari')
    : join(root, output, process.platform === 'win32' ? 'ari.exe' : 'ari')
  try {
    for (const arch of launchArches()) {
      const result = await smoke({
        executable,
        resources,
        arch,
        executableSha256: await sha256(executable),
        asarSha256: await sha256(archivePath(resources, arch)),
        dataRoot: resolve(process.env.RUNNER_TEMP ?? 'dist', 'ari-candidate-native-data'),
      })
      assert.equal(result.version, version, 'Packaged native probe version mismatch')
      assert.equal(result.platform, process.platform, 'Packaged native probe platform mismatch')
      receipt.native.push(result)
    }
  } catch (error) {
    receipt.nativeFailure = String(error)
    throw error
  } finally {
    await writeFile(join(root, 'candidate-artifacts.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  }
  console.log(JSON.stringify(receipt, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
}
