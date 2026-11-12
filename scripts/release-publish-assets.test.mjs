import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_SHA256 } from './release-functional-support.mjs'
import { BASELINE } from './release-install-smoke.mjs'
import {
  validateIdentity,
  validateFunctional,
  validateInstalled,
  validateMacosSlices,
  validateRemote,
  assemble,
} from './release-publish-assets.mjs'
const head = 'a'.repeat(40)
const hash = 'b'.repeat(64)
function installProof(platform, native, candidate, functional) {
  return {
    sourceHead: head,
    platform,
    passed: true,
    native,
    functional,
    installation: {
      sourceHead: head,
      platform,
      passed: true,
      kind: 'installed-candidate-equivalence',
      previous: BASELINE[platform],
      candidate,
      sequence: [{ version: '0.3.13' }, { version: '0.3.14' }],
      fixture: { beforeSha256: hash, afterSha256: hash },
      osInstallerBehaviorTested: platform === 'win32',
      extractionOnly: platform === 'linux',
      updaterBehaviorTested: false,
      applicationProfileStartupTested: false,
      nativeBehaviorTested: false,
      installed: {
        executableSha256: hash,
        archives: native.map((entry) => ({ arch: entry.arch, archive: entry.archive })),
      },
    },
  }
}
function suiteFor(arch, suiteRoot) {
  return {
    suiteRoot,
    sourceHead: head,
    executableSha256: hash,
    asarSha256: hash,
    passed: true,
    profiles: [0, 1].map((index) => ({
      preparation: index
        ? { kind: 'frozen-0312-copy', fixtureSha256: FIXTURE_SHA256 }
        : { kind: 'clean-safety-profile' },
      observed: true,
      failure: null,
      main: { arch, appVersion: '0.3.14', isPackaged: true, errors: [] },
      exit: { code: 0, signal: null, forced: false, timedOut: false },
    })),
  }
}
// Mirrors the package job's transfer receipt and the Intel job's uploaded evidence.
async function intelEvidence(root, packageRoot, verified, arm64) {
  const zip = verified.files.find((file) => file.name === 'Ari-0.3.14-universal.zip')
  await writeFile(
    join(packageRoot, 'macos-intel-transfer.json'),
    JSON.stringify({
      kind: 'macos-universal-transfer',
      sourceHead: head,
      version: '0.3.14',
      platform: 'darwin',
      arch: 'x64',
      nativeExecuted: false,
      zip,
      archiveName: 'app.asar',
      executableSha256: hash,
      asarSha256: hash,
      bootstrapSha256: hash,
    }),
  )
  const intelRoot = join(root, `ari-macos-intel-x64-${head}`, 'intel-test')
  const suiteRoot = join(intelRoot, 'functional-test')
  await mkdir(suiteRoot, { recursive: true })
  await writeFile(join(suiteRoot, 'suite.json'), JSON.stringify(suiteFor('x64', suiteRoot)))
  await writeFile(
    join(intelRoot, 'diagnostic.json'),
    JSON.stringify({
      kind: 'macos-intel-diagnostic',
      sourceHead: head,
      runner: 'macos-26-intel',
      platform: 'darwin',
      arch: 'x64',
      zip: { name: zip.name, bytes: zip.bytes, sha256: zip.sha256 },
      native: { ...arm64, arch: 'x64', archive: '/synthetic/intel/app.asar' },
      functional: { passed: true, suiteRoot },
    }),
  )
}
async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ari-release-assets-'))
  const { verifyArtifacts } = await import('./release-artifacts.mjs')
  for (const [os, platform, update, metadata, extra, arches] of [
    [
      'windows-latest',
      'win32',
      'Ari-Setup-0.3.14.exe',
      'latest.yml',
      ['Ari-Setup-0.3.14.exe.blockmap'],
      ['x64'],
    ],
    [
      'macos-latest',
      'darwin',
      'Ari-0.3.14-universal.zip',
      'latest-mac.yml',
      [
        'Ari-0.3.14-universal.zip.blockmap',
        'Ari-0.3.14-universal.dmg',
        'Ari-0.3.14-universal.dmg.blockmap',
      ],
      // The package runner launches ARM64; x64 comes from the Intel runner below.
      ['arm64'],
    ],
    [
      'ubuntu-latest',
      'linux',
      'Ari-0.3.14.AppImage',
      'latest-linux.yml',
      ['Ari-0.3.14.deb'],
      ['x64'],
    ],
  ]) {
    const packageRoot = join(root, `ari-candidate-${os}-${head}`)
    const functionalRoot = join(root, `ari-functional-${os}-${head}`)
    const installRoot = join(root, `ari-install-${os}-${head}`)
    await mkdir(packageRoot)
    await mkdir(functionalRoot)
    await mkdir(installRoot)
    const bytes = Buffer.from('synthetic installer data; never executable')
    for (const name of [update, ...extra]) await writeFile(join(packageRoot, name), bytes)
    await writeFile(
      join(packageRoot, metadata),
      JSON.stringify({
        version: '0.3.14',
        files: [
          {
            url: update,
            size: bytes.length,
            sha512: createHash('sha512').update(bytes).digest('base64'),
          },
        ],
      }),
    )
    const verified = await verifyArtifacts(packageRoot, platform, '0.3.14')
    const native = arches.map((arch) => ({
      arch,
      platform,
      version: '0.3.14',
      electron: '43.4.1',
      kind: 'packaged-native-module-load',
      physicalBehaviorTested: false,
      executableSha256: hash,
      asarSha256: hash,
      archive: `/synthetic/installed/${platform}/${arch}/app.asar`,
      modules: Object.fromEntries(
        ['@lydell/node-pty', 'koffi', 'uiohook-napi'].map((name) => [name, { loaded: true }]),
      ),
    }))
    await writeFile(
      join(packageRoot, 'candidate-artifacts.json'),
      JSON.stringify({ ...verified, sourceHead: head, native }),
    )
    const installedSuites = []
    for (const arch of arches) {
      const folder = join(functionalRoot, arch)
      await mkdir(folder)
      await writeFile(
        join(folder, 'suite.json'),
        JSON.stringify({
          suiteRoot: folder,
          sourceHead: head,
          executableSha256: hash,
          asarSha256: hash,
          passed: true,
          profiles: [0, 1].map((index) => ({
            preparation: index
              ? { kind: 'frozen-0312-copy', fixtureSha256: FIXTURE_SHA256 }
              : { kind: 'clean-safety-profile' },
            observed: true,
            failure: null,
            main: { arch, appVersion: '0.3.14', isPackaged: true, errors: [] },
            exit: { code: 0, signal: null, forced: false, timedOut: false },
          })),
        }),
      )
      const installedFolder = join(installRoot, arch)
      await mkdir(installedFolder)
      const suite = JSON.parse(await readFile(join(folder, 'suite.json'), 'utf8'))
      suite.suiteRoot = installedFolder
      await writeFile(join(installedFolder, 'suite.json'), JSON.stringify(suite))
      installedSuites.push({ arch, suiteRoot: installedFolder })
    }
    if (platform === 'darwin') await intelEvidence(root, packageRoot, verified, native[0])
    const installerName = BASELINE[platform].name.replace('0.3.13', '0.3.14')
    await writeFile(
      join(installRoot, 'installed-probes.json'),
      JSON.stringify(
        installProof(
          platform,
          native,
          verified.files.find((file) => file.name === installerName),
          installedSuites,
        ),
      ),
    )
  }
  return root
}

test('assembly rehashes the complete real file set before staging uploadable assets', async () => {
  const root = await releaseFixture()
  const output = join(root, 'stage')
  const plan = await assemble(root, output, head, '0.3.14')
  assert.equal(plan.files.length, 13)
  for (const file of plan.files) {
    const bytes = await readFile(join(output, file.name))
    assert.equal(file.bytes, bytes.length)
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
  const manifest = JSON.parse(await readFile(join(output, 'release-manifest.json'), 'utf8'))
  assert.equal(manifest.platforms.length, 3)
  assert.deepEqual(
    manifest.platforms[1].architectures.map((entry) => entry.arch),
    ['arm64', 'x64'],
  )
})

test('macOS publication needs the Intel x64 launch of the same universal build', async () => {
  const root = await releaseFixture()
  const packageRoot = join(root, `ari-candidate-macos-latest-${head}`)
  const intelPath = join(root, `ari-macos-intel-x64-${head}`, 'intel-test', 'diagnostic.json')
  const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
  const receipt = await read(join(packageRoot, 'candidate-artifacts.json'))
  const transfer = await read(join(packageRoot, 'macos-intel-transfer.json'))
  const intel = await read(intelPath)
  assert.deepEqual(
    validateMacosSlices(receipt, transfer, intel, head).native.map((entry) => entry.arch),
    ['arm64', 'x64'],
  )
  const other = 'c'.repeat(64)
  for (const [target, mutate] of [
    ['receipt', (value) => value.native.push({ ...value.native[0], arch: 'x64' })],
    ['receipt', (value) => (value.native = [])],
    ['transfer', (value) => (value.sourceHead = 'c'.repeat(40))],
    ['transfer', (value) => (value.zip.sha256 = other)],
    ['transfer', (value) => (value.executableSha256 = other)],
    ['intel', (value) => (value.sourceHead = 'c'.repeat(40))],
    ['intel', (value) => (value.runner = 'macos-latest')],
    ['intel', (value) => (value.arch = 'arm64')],
    ['intel', (value) => (value.error = 'Timed out')],
    ['intel', (value) => (value.functional.passed = false)],
    ['intel', (value) => (value.zip.sha256 = other)],
    ['intel', (value) => (value.native.executableSha256 = other)],
    ['intel', (value) => (value.native.asarSha256 = other)],
    ['intel', (value) => (value.native = null)],
  ]) {
    const inputs = globalThis.structuredClone({ receipt, transfer, intel })
    mutate(inputs[target])
    assert.throws(() => validateMacosSlices(inputs.receipt, inputs.transfer, inputs.intel, head))
  }
  // Assembly itself refuses a missing or failed Intel proof.
  await writeFile(intelPath, JSON.stringify({ ...intel, functional: { passed: false } }))
  await assert.rejects(assemble(root, join(root, 'blocked-intel'), head, '0.3.14'), /Intel/)
  await rm(join(root, `ari-macos-intel-x64-${head}`), { recursive: true })
  await assert.rejects(assemble(root, join(root, 'missing-intel'), head, '0.3.14'))
  await assert.rejects(stat(join(root, 'missing-intel')), { code: 'ENOENT' })
})

test('missing installed evidence cannot stage an otherwise valid package set', async () => {
  const root = await releaseFixture()
  await writeFile(
    join(root, `ari-install-windows-latest-${head}`, 'installed-probes.json'),
    JSON.stringify({ passed: false }),
  )
  const output = join(root, 'blocked-install')
  await assert.rejects(assemble(root, output, head, '0.3.14'))
  await assert.rejects(stat(output), { code: 'ENOENT' })
})

test('installed publication proof rejects wrong baseline, missing native slice, stale or failed suites', async () => {
  const root = await releaseFixture()
  const receipt = JSON.parse(
    await readFile(
      join(root, `ari-candidate-windows-latest-${head}`, 'candidate-artifacts.json'),
      'utf8',
    ),
  )
  const installRoot = join(root, `ari-install-windows-latest-${head}`)
  const proof = JSON.parse(await readFile(join(installRoot, 'installed-probes.json'), 'utf8'))
  const suite = JSON.parse(await readFile(join(installRoot, 'x64', 'suite.json'), 'utf8'))
  const summary = validateInstalled(receipt, proof, [suite], head, 'win32')
  assert.equal(summary.osInstallerBehaviorTested, true)
  assert.equal(summary.chromiumProfileMigrationTested, false)
  for (const mutate of [
    (value) => {
      value.passed = false
    },
    (value) => {
      value.sourceHead = 'c'.repeat(40)
    },
    (value) => {
      value.installation.previous.sha256 = hash
    },
    (value) => {
      value.installation.candidate.sha256 = hash
    },
    (value) => {
      value.installation.fixture.afterSha256 = 'c'.repeat(64)
    },
    (value) => {
      value.native = []
    },
    (value) => {
      value.native[0].modules.koffi.loaded = false
    },
    (value) => {
      value.functional[0].suiteRoot = '/unrelated'
    },
  ]) {
    const modified = globalThis.structuredClone(proof)
    mutate(modified)
    assert.throws(() => validateInstalled(receipt, modified, [suite], head, 'win32'))
  }
  assert.throws(() =>
    validateInstalled(receipt, proof, [{ ...suite, passed: false }], head, 'win32'),
  )
})

test('missing platform input or changed bytes cannot produce publication staging', async () => {
  const root = await releaseFixture()
  const output = join(root, 'blocked')
  await writeFile(
    join(root, `ari-candidate-windows-latest-${head}`, 'Ari-Setup-0.3.14.exe'),
    'corrupted',
  )
  await assert.rejects(assemble(root, output, head, '0.3.14'), /size mismatch|checksum mismatch/)
  await assert.rejects(stat(output), { code: 'ENOENT' })
  await assert.rejects(assemble(join(root, 'missing-input'), output, head, '0.3.14'))
  await assert.rejects(stat(output), { code: 'ENOENT' })
})
test('tag needs the latest successful required check at the exact tagged head', () => {
  const input = {
    tag: 'v0.3.14',
    version: '0.3.14',
    head,
    tagCommit: head,
    check: { name: 'verify', head_sha: head, status: 'completed', conclusion: 'success' },
  }
  validateIdentity(input)
  for (const edit of [
    { tag: 'v0.3.12' },
    { tagCommit: 'c'.repeat(40) },
    { check: null },
    { check: { ...input.check, head_sha: 'c'.repeat(40) } },
    { check: { ...input.check, conclusion: 'failure' } },
    { check: { ...input.check, status: 'in_progress' } },
  ])
    assert.throws(() => validateIdentity({ ...input, ...edit }))
})
test('publication needs both universal slices and both packaged profile proofs', () => {
  const native = (arch) => ({
    arch,
    kind: 'packaged-native-module-load',
    platform: 'darwin',
    version: '0.3.14',
    electron: '43.4.1',
    executableSha256: hash,
    asarSha256: hash,
    physicalBehaviorTested: false,
  })
  const result = (arch) => ({
    sourceHead: head,
    executableSha256: hash,
    asarSha256: hash,
    passed: true,
    profiles: Array.from({ length: 2 }, (_, index) => ({
      preparation: index
        ? { kind: 'frozen-0312-copy', fixtureSha256: FIXTURE_SHA256 }
        : { kind: 'clean-safety-profile' },
      observed: true,
      failure: null,
      main: { arch, appVersion: '0.3.14', isPackaged: true, errors: [] },
      exit: { code: 0, signal: null, forced: false, timedOut: false },
    })),
  })
  const receipt = {
    sourceHead: head,
    platform: 'darwin',
    version: '0.3.14',
    native: [native('arm64'), native('x64')],
  }
  validateFunctional(receipt, [result('arm64'), result('x64')], head, 'darwin')
  for (const results of [
    [result('arm64')],
    [result('arm64'), result('arm64')],
    [result('arm64'), { ...result('x64'), sourceHead: 'c'.repeat(40) }],
    [result('arm64'), { ...result('x64'), passed: false }],
    [result('arm64'), { ...result('x64'), profiles: [result('x64').profiles[0]] }],
  ])
    assert.throws(() => validateFunctional(receipt, results, head, 'darwin'))
})
test('only a complete checksum-matched draft can become public', () => {
  const plan = {
    tag: 'v0.3.14',
    files: [
      { name: 'test.exe', bytes: 10, sha256: hash },
      { name: 'SHA256SUMS', bytes: 20, sha256: hash },
    ],
  }
  const release = {
    tag_name: plan.tag,
    draft: true,
    prerelease: false,
    assets: plan.files.map((file) => ({
      name: file.name,
      size: file.bytes,
      digest: `sha256:${file.sha256}`,
      state: 'uploaded',
    })),
  }
  validateRemote(plan, release)
  for (const edit of [
    { draft: false },
    { tag_name: 'v0.3.12' },
    { assets: release.assets.slice(0, 1) },
    { assets: release.assets.map((asset) => ({ ...asset, digest: 'sha256:wrong' })) },
    { assets: release.assets.map((asset) => ({ ...asset, size: 99 })) },
  ])
    assert.throws(() => validateRemote(plan, { ...release, ...edit }))
})
