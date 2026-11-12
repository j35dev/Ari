// Release-only gates: exact tested tag, complete platform proofs, then draft assets.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURE_SHA256 } from './release-functional-support.mjs'
import { BASELINE } from './release-install-baseline.mjs'

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

async function records(root, filename) {
  const results = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), 'Unexpected symlink in release evidence')
    const path = join(root, entry.name)
    if (entry.isDirectory()) results.push(...(await records(path, filename)))
    else if (entry.name === filename) results.push(JSON.parse(await readFile(path, 'utf8')))
  }
  return results
}

export function validateInstalled(receipt, proof, results, sourceHead, platform) {
  assert.equal(proof.sourceHead, sourceHead)
  assert.equal(proof.platform, platform)
  assert.equal(proof.passed, true, 'Installed-path probes did not pass')
  const install = proof.installation
  assert.equal(install.sourceHead, sourceHead)
  assert.equal(install.platform, platform)
  assert.equal(install.kind, 'installed-candidate-equivalence')
  assert.equal(install.passed, true)
  assert.equal(install.previous.name, BASELINE[platform].name)
  assert.equal(install.previous.bytes, BASELINE[platform].bytes)
  assert.equal(install.previous.sha256, BASELINE[platform].sha256)
  const candidate = receipt.files.find((file) => file.name === install.candidate.name)
  assert.ok(candidate, 'Installed artifact absent from tested package')
  assert.equal(install.candidate.bytes, candidate.bytes)
  assert.equal(install.candidate.sha256, candidate.sha256)
  assert.deepEqual(
    install.sequence.map((entry) => entry.version),
    ['0.3.13', '0.3.14'],
  )
  assert.equal(install.fixture.beforeSha256, install.fixture.afterSha256)
  assert.equal(install.osInstallerBehaviorTested, platform === 'win32')
  assert.equal(install.extractionOnly, platform === 'linux')
  assert.equal(install.updaterBehaviorTested, false)
  assert.equal(install.applicationProfileStartupTested, false)
  assert.equal(install.nativeBehaviorTested, false)
  assert.equal(install.installed.executableSha256, receipt.native[0].executableSha256)
  for (const native of proof.native) {
    const packaged = receipt.native.find((entry) => entry.arch === native.arch)
    assert.ok(packaged)
    assert.equal(
      native.archive,
      install.installed.archives.find((entry) => entry.arch === native.arch)?.archive,
    )
    assert.equal(native.executableSha256, packaged.executableSha256)
    assert.equal(native.asarSha256, packaged.asarSha256)
    for (const name of ['@lydell/node-pty', 'koffi', 'uiohook-napi'])
      assert.equal(native.modules?.[name]?.loaded, true)
  }
  assert.equal(proof.functional.length, receipt.native.length)
  assert.deepEqual(
    proof.functional.map((entry) => entry.arch).sort(),
    receipt.native.map((entry) => entry.arch).sort(),
  )
  assert.equal(
    new Set(proof.functional.map((entry) => entry.suiteRoot)).size,
    proof.functional.length,
  )
  assert.deepEqual(
    results.map((entry) => entry.suiteRoot).sort(),
    proof.functional.map((entry) => entry.suiteRoot).sort(),
  )
  validateFunctional(
    { ...receipt, native: proof.native },
    results,
    sourceHead,
    platform,
    installedArches(platform),
  )
  return {
    installationKind: install.installationKind,
    osInstallerBehaviorTested: install.osInstallerBehaviorTested,
    extractionOnly: install.extractionOnly,
    installedModuleLoadAndCopiedProfileSmoke: true,
    updaterBehaviorTested: false,
    preservedFixtureSibling: true,
    chromiumProfileMigrationTested: false,
    physicalBehaviorTested: false,
  }
}

// Installs run on the package runner, which launches only its native slice.
const installedArches = (platform) => (platform === 'darwin' ? ['arm64'] : ['x64'])

/**
 * The hosted macOS package runner launches only ARM64. The x64 slice of the same
 * universal build launches on the real Intel runner, which must report the exact
 * ZIP, executable and x64 archive the package job recorded in its transfer receipt.
 * Returns the package receipt with both proven slices.
 */
export function validateMacosSlices(receipt, transfer, intel, sourceHead) {
  assert.equal(receipt.sourceHead, sourceHead)
  assert.equal(receipt.platform, 'darwin')
  assert.deepEqual(
    receipt.native.map((entry) => entry.arch),
    ['arm64'],
    'macOS package runner must prove exactly the native ARM64 slice',
  )
  const arm64 = receipt.native[0]
  assert.equal(transfer?.kind, 'macos-universal-transfer')
  assert.equal(transfer.sourceHead, sourceHead.toLowerCase(), 'Transfer is for another head')
  assert.equal(transfer.version, receipt.version)
  assert.equal(transfer.platform, 'darwin')
  assert.equal(transfer.arch, 'x64')
  assert.equal(transfer.nativeExecuted, false)
  const zip = receipt.files.find((file) => file.name === transfer.zip?.name)
  assert.ok(zip && zip.name.endsWith('-universal.zip'), 'Transferred ZIP absent from package')
  assert.equal(transfer.zip.bytes, zip.bytes, 'Transferred ZIP differs from package')
  assert.equal(transfer.zip.sha256, zip.sha256, 'Transferred ZIP differs from package')
  assert.equal(
    transfer.executableSha256,
    arm64.executableSha256,
    'Transfer differs from the tested universal executable',
  )
  assert.equal(intel?.kind, 'macos-intel-diagnostic')
  assert.equal(intel.sourceHead, sourceHead, 'Intel proof is for another head')
  assert.equal(intel.runner, 'macos-26-intel')
  assert.equal(intel.platform, 'darwin')
  assert.equal(intel.arch, 'x64', 'Intel proof did not run natively on x64')
  assert.equal(intel.error, undefined, 'Intel x64 launch failed')
  assert.equal(intel.functional?.passed, true, 'Intel x64 functional proof did not pass')
  for (const key of ['name', 'bytes', 'sha256'])
    assert.equal(intel.zip?.[key], zip[key], 'Intel proof launched a different ZIP')
  const x64 = intel.native
  assert.equal(x64?.arch, 'x64')
  assert.equal(x64.executableSha256, transfer.executableSha256, 'Intel executable differs')
  assert.equal(x64.asarSha256, transfer.asarSha256, 'Intel x64 archive differs')
  return { ...receipt, native: [arm64, x64] }
}

export function validateFunctional(
  receipt,
  results,
  sourceHead,
  platform,
  arches = platform === 'darwin' ? ['arm64', 'x64'] : ['x64'],
) {
  assert.equal(receipt.sourceHead, sourceHead)
  assert.equal(receipt.platform, platform)
  assert.ok(!receipt.nativeFailure, 'Failed native gate')
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
    let tested = receipt
    const suites = await records(
      join(inputRoot, `ari-functional-${os}-${sourceHead}`),
      'suite.json',
    )
    if (platform === 'darwin') {
      const intelRoot = join(inputRoot, `ari-macos-intel-x64-${sourceHead}`)
      const intel = await records(intelRoot, 'diagnostic.json')
      assert.equal(intel.length, 1, 'Missing or duplicate Intel x64 proof')
      const transfer = JSON.parse(await readFile(join(root, 'macos-intel-transfer.json'), 'utf8'))
      tested = validateMacosSlices(receipt, transfer, intel[0], sourceHead)
      suites.push(...(await records(intelRoot, 'suite.json')))
    }
    validateFunctional(tested, suites, sourceHead, platform)
    const installRoot = join(inputRoot, `ari-install-${os}-${sourceHead}`)
    const installedProofs = await records(installRoot, 'installed-probes.json')
    assert.equal(installedProofs.length, 1, 'Missing or duplicate installed proof')
    const installation = validateInstalled(
      receipt,
      installedProofs[0],
      await records(installRoot, 'suite.json'),
      sourceHead,
      platform,
    )
    manifest.files.push(...verified.files.map((file) => ({ ...file, platform })))
    manifest.platforms.push({
      platform,
      installation,
      architectures: tested.native.map((entry) => ({
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
