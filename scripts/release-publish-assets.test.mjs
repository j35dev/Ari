import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_SHA256 } from './release-functional-support.mjs'
import { BASELINE } from './release-install-smoke.mjs'
import {
  validateIdentity,
  validateFunctional,
  validateInstalled,
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
      sequence: [{ version: '0.3.12' }, { version: '0.3.13' }],
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
async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ari-release-assets-'))
  const { verifyArtifacts } = await import('./release-artifacts.mjs')
  for (const [os, platform, update, metadata, extra, arches] of [
    [
      'windows-latest',
      'win32',
      'Ari-Setup-0.3.13.exe',
      'latest.yml',
      ['Ari-Setup-0.3.13.exe.blockmap'],
      ['x64'],
    ],
    [
      'macos-latest',
      'darwin',
      'Ari-0.3.13-universal.zip',
      'latest-mac.yml',
      [
        'Ari-0.3.13-universal.zip.blockmap',
        'Ari-0.3.13-universal.dmg',
        'Ari-0.3.13-universal.dmg.blockmap',
      ],
      ['arm64', 'x64'],
    ],
    [
      'ubuntu-latest',
      'linux',
      'Ari-0.3.13.AppImage',
      'latest-linux.yml',
      ['Ari-0.3.13.deb'],
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
        version: '0.3.13',
        files: [
          {
            url: update,
            size: bytes.length,
            sha512: createHash('sha512').update(bytes).digest('base64'),
          },
        ],
      }),
    )
    const verified = await verifyArtifacts(packageRoot, platform, '0.3.13')
    const native = arches.map((arch) => ({
      arch,
      platform,
      version: '0.3.13',
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
            main: { arch, appVersion: '0.3.13', isPackaged: true, errors: [] },
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
    const installerName = BASELINE[platform].name.replace('0.3.12', '0.3.13')
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
  const plan = await assemble(root, output, head, '0.3.13')
  assert.equal(plan.files.length, 13)
  for (const file of plan.files) {
    const bytes = await readFile(join(output, file.name))
    assert.equal(file.bytes, bytes.length)
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
  const manifest = JSON.parse(await readFile(join(output, 'release-manifest.json'), 'utf8'))
  assert.equal(manifest.platforms.length, 3)
  assert.equal(manifest.platforms[1].architectures.length, 2)
})

test('missing installed evidence cannot stage an otherwise valid package set', async () => {
  const root = await releaseFixture()
  await writeFile(
    join(root, `ari-install-windows-latest-${head}`, 'installed-probes.json'),
    JSON.stringify({ passed: false }),
  )
  const output = join(root, 'blocked-install')
  await assert.rejects(assemble(root, output, head, '0.3.13'))
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
    join(root, `ari-candidate-windows-latest-${head}`, 'Ari-Setup-0.3.13.exe'),
    'corrupted',
  )
  await assert.rejects(assemble(root, output, head, '0.3.13'), /size mismatch|checksum mismatch/)
  await assert.rejects(stat(output), { code: 'ENOENT' })
  await assert.rejects(assemble(join(root, 'missing-input'), output, head, '0.3.13'))
  await assert.rejects(stat(output), { code: 'ENOENT' })
})
test('tag needs the latest successful required check at the exact tagged head', () => {
  const input = {
    tag: 'v0.3.13',
    version: '0.3.13',
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
    version: '0.3.13',
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
      main: { arch, appVersion: '0.3.13', isPackaged: true, errors: [] },
      exit: { code: 0, signal: null, forced: false, timedOut: false },
    })),
  })
  const receipt = {
    sourceHead: head,
    platform: 'darwin',
    version: '0.3.13',
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
    tag: 'v0.3.13',
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
