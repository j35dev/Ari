// Release-only gates: exact tested tag, complete platform proofs, then draft assets.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_SHA256 } from './release-functional-support.mjs'

export function validateIdentity({ tag, version, head, tagCommit, check }) {
  assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/, 'Use a stable version tag')
  assert.equal(tag, `v${version}`, 'Tag differs from desktop version')
  assert.match(head ?? '', /^[a-f0-9]{40}$/i)
  assert.equal(tagCommit, head, 'Checkout differs from existing tag')
  assert.equal(check?.name, 'verify', 'Missing required exact-head verify')
  assert.equal(check?.head_sha, head)
  assert.equal(check?.status, 'completed')
  assert.equal(check?.conclusion, 'success', 'Latest required verify did not pass')
}

async function suites(root) {
  const results = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Unexpected symlink in release evidence')
    const path = join(root, entry.name)
    if (entry.isDirectory()) results.push(...(await suites(path)))
    else if (entry.name === 'suite.json') results.push(JSON.parse(await readFile(path, 'utf8')))
  }
  return results
}

export function validateFunctional(receipt, results, sourceHead, platform) {
  assert.equal(receipt.sourceHead, sourceHead)
  assert.equal(receipt.platform, platform)
  assert.ok(!receipt.nativeFailure, 'Failed native gate')
  const arches = platform === 'darwin' ? ['arm64', 'x64'] : ['x64']
  assert.deepEqual(receipt.native.map((entry) => entry.arch).sort(), [...arches].sort())
  assert.equal(results.length, arches.length, 'Missing or duplicate functional slice proofs')
  for (const native of receipt.native) {
    assert.equal(native.kind, 'packaged-native-module-load')
    assert.ok(native.electron)
    assert.equal(native.platform, platform)
    assert.equal(native.version, receipt.version)
    assert.equal(native.physicalBehaviorTested, false)
    for (const hash of [native.executableSha256, native.asarSha256])
      assert.match(hash ?? '', /^[a-f0-9]{64}$/i)
    const matching = results.filter((suite) => suite.profiles?.[0]?.main?.arch === native.arch)
    assert.equal(matching.length, 1, 'Missing/ambiguous functional architecture')
    const result = matching[0]
    assert.equal(result.sourceHead, sourceHead)
    assert.equal(result.executableSha256, native.executableSha256)
    assert.equal(result.asarSha256, native.asarSha256)
    assert.equal(result.passed, true)
    assert.equal(result.profiles.length, 2, 'Clean and copied-upgrade profiles required')
    assert.deepEqual(
      result.profiles.map((profile) => profile.preparation.kind),
      ['clean-safety-profile', 'frozen-0312-copy'],
      'Distinct clean and frozen upgrade proofs required',
    )
    assert.equal(result.profiles[1].preparation.fixtureSha256, FIXTURE_SHA256)
    for (const profile of result.profiles) {
      assert.equal(profile.observed, true)
      assert.equal(profile.main.arch, native.arch)
      assert.equal(profile.main.appVersion, receipt.version)
      assert.ok(profile.main.isPackaged)
      assert.deepEqual(profile.main.errors, [])
      assert.equal(profile.failure, null)
      assert.equal(profile.exit.code, 0)
      assert.equal(profile.exit.signal, null)
      assert.equal(profile.exit.forced, false)
      assert.equal(profile.exit.timedOut, false)
    }
  }
}

export async function assemble(inputRoot, outputRoot, sourceHead, version) {
  const { verifyArtifacts } = await import('./release-artifacts.mjs')
  const platforms = [
    ['windows-latest', 'win32'],
    ['macos-latest', 'darwin'],
    ['ubuntu-latest', 'linux'],
  ]
  const manifest = { sourceHead, version, files: [], platforms: [] }
  for (const [os, platform] of platforms) {
    const root = join(inputRoot, `ari-candidate-${os}-${sourceHead}`)
    const receipt = JSON.parse(await readFile(join(root, 'candidate-artifacts.json'), 'utf8'))
    const verified = await verifyArtifacts(root, platform, version)
    assert.equal(receipt.version, version)
    assert.deepEqual(receipt.files, verified.files, 'Artifacts differ from recorded package hashes')
    validateFunctional(
      receipt,
      await suites(join(inputRoot, `ari-functional-${os}-${sourceHead}`)),
      sourceHead,
      platform,
    )
    manifest.files.push(...verified.files.map((file) => ({ ...file, platform })))
    manifest.platforms.push({
      platform,
      architectures: receipt.native.map((entry) => ({
        arch: entry.arch,
        electron: entry.electron,
        executableSha256: entry.executableSha256,
        asarSha256: entry.asarSha256,
        packagedModuleLoad: true,
        cleanAndCopiedProfileSmoke: true,
        physicalBehaviorTested: false,
      })),
    })
  }
  assert.equal(new Set(manifest.files.map((file) => file.name)).size, manifest.files.length)
  await mkdir(outputRoot)
  for (const [os, platform] of platforms)
    for (const file of manifest.files.filter((file) => file.platform === platform))
      await copyFile(
        join(inputRoot, `ari-candidate-${os}-${sourceHead}`, file.name),
        join(outputRoot, file.name),
      )
  await writeFile(
    join(outputRoot, 'SHA256SUMS'),
    manifest.files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
  )
  await writeFile(
    join(outputRoot, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  const uploads = [...manifest.files]
  for (const name of ['SHA256SUMS', 'release-manifest.json']) {
    const bytes = await readFile(join(outputRoot, name))
    uploads.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return { sourceHead, version, tag: `v${version}`, files: uploads }
}

export function validateRemote(plan, release) {
  assert.equal(release.tag_name, plan.tag)
  assert.equal(release.draft, true, 'Validate complete uploads before public publication')
  assert.equal(release.prerelease, false)
  assert.deepEqual(
    release.assets.map((asset) => asset.name).sort(),
    plan.files.map((file) => file.name).sort(),
    'Incomplete or unexpected remote assets',
  )
  for (const file of plan.files) {
    const asset = release.assets.find((asset) => asset.name === file.name)
    assert.equal(asset.state, 'uploaded')
    assert.equal(asset.size, file.bytes)
    assert.equal(asset.digest, `sha256:${file.sha256}`, `Remote digest mismatch: ${file.name}`)
  }
}

async function main() {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    'true',
    'Release publication gates are GitHub Actions-only',
  )
  const command = process.argv[2]
  if (command === 'identify') {
    const tag = process.env.RELEASE_TAG
    assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/)
    const git = (...args) =>
      execFileSync('git', args, { windowsHide: true, encoding: 'utf8' }).trim()
    const head = git('rev-parse', 'HEAD')
    const version = JSON.parse(await readFile('apps/desktop/package.json', 'utf8')).version
    const checks = JSON.parse(
      execFileSync('gh', ['api', `repos/j35dev/Ari/commits/${head}/check-runs`], {
        windowsHide: true,
        encoding: 'utf8',
      }),
    )
      .check_runs.filter((check) => check.name === 'verify')
      .sort((a, b) => b.id - a.id)
    validateIdentity({
      tag,
      version,
      head,
      tagCommit: git('rev-parse', `refs/tags/${tag}^{commit}`),
      check: checks[0],
    })
    git('merge-base', '--is-ancestor', head, 'origin/main')
    await appendFile(process.env.GITHUB_OUTPUT, `sha=${head}\nversion=${version}\n`)
    console.log(`Verified ${tag} at ${head}`)
  } else if (command === 'assemble') {
    assert.match(process.env.CANDIDATE_SHA ?? '', /^[a-f0-9]{40}$/i)
    const plan = await assemble(
      resolve('release-inputs'),
      resolve('release-stage'),
      process.env.CANDIDATE_SHA,
      process.env.RELEASE_VERSION,
    )
    await writeFile('release-upload-plan.json', JSON.stringify(plan, null, 2) + '\n')
    console.log(`Prepared ${plan.files.length} validated release assets`)
  } else if (command === 'verify-remote') {
    const plan = JSON.parse(await readFile('release-upload-plan.json', 'utf8'))
    assert.equal(plan.sourceHead, process.env.CANDIDATE_SHA)
    const release = JSON.parse(
      execFileSync('gh', ['api', `repos/j35dev/Ari/releases/tags/${plan.tag}`], {
        windowsHide: true,
        encoding: 'utf8',
      }),
    )
    validateRemote(plan, release)
    console.log(`Verified complete draft assets for ${plan.tag}`)
  } else throw new Error('Use identify, assemble or verify-remote')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
