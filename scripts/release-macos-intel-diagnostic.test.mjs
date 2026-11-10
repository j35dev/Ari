import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  EXTRACT_TIMEOUT_MS,
  TRANSFER_NAME,
  assertBundlePin,
  assertHostedDiagnosis,
  assertZipPin,
  diagnoseTransferred,
  hostedIsolation,
  locateUniversalExecutable,
  runDiagnosis,
  universalTransferReceipt,
  x64DiagnosticPlan,
} from './release-macos-intel-diagnostic.mjs'

const version = '0.3.13'
const source = 'a305270df41ac5e37c66861e5feb700de0d66b97'
const zipBytes = Buffer.from('synthetic universal zip; never executed')
const executableBytes = Buffer.from('synthetic universal executable')
const bootstrapBytes = Buffer.from('synthetic app.asar')
const x64Bytes = Buffer.from('synthetic app-x64.asar')

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function dist() {
  const root = await mkdtemp(join(tmpdir(), 'ari-intel-transfer-'))
  const names = [
    `Ari-${version}-universal.zip`,
    `Ari-${version}-universal.zip.blockmap`,
    `Ari-${version}-universal.dmg`,
    `Ari-${version}-universal.dmg.blockmap`,
  ]
  for (const name of names) await writeFile(join(root, name), zipBytes)
  await writeFile(
    join(root, 'latest-mac.yml'),
    JSON.stringify({
      version,
      files: [
        {
          url: `Ari-${version}-universal.zip`,
          size: zipBytes.length,
          sha512: createHash('sha512').update(zipBytes).digest('base64'),
        },
      ],
    }),
  )
  const resources = join(root, 'mac-universal/ari.app/Contents/Resources')
  await mkdir(join(root, 'mac-universal/ari.app/Contents/MacOS'), { recursive: true })
  await mkdir(resources, { recursive: true })
  await writeFile(join(root, 'mac-universal/ari.app/Contents/MacOS/ari'), executableBytes)
  await writeFile(join(resources, 'app.asar'), bootstrapBytes)
  await writeFile(join(resources, 'app-x64.asar'), x64Bytes)
  return root
}

function observed(receipt, patch = {}) {
  return {
    sourceHead: source,
    platform: 'darwin',
    arch: 'x64',
    hostArch: 'x64',
    zipSha256: receipt.zip.sha256,
    zipBytes: receipt.zip.bytes,
    executableSha256: receipt.executableSha256,
    asarSha256: receipt.asarSha256,
    bootstrapSha256: receipt.bootstrapSha256,
    isolated: true,
    ...patch,
  }
}

const nativeOk = {
  kind: 'packaged-native-module-load',
  arch: 'x64',
  platform: 'darwin',
  version,
  physicalBehaviorTested: false,
  electron: '43.4.1',
}

test('transfer receipt is verifyArtifacts output plus file hashes and no native claim', async () => {
  const receipt = await universalTransferReceipt(await dist(), version, source.toUpperCase())
  assert.equal(receipt.kind, 'macos-universal-transfer')
  assert.equal(receipt.nativeExecuted, false)
  assert.equal(receipt.sourceHead, source)
  assert.equal(receipt.archiveName, 'app-x64.asar')
  assert.equal(receipt.zip.sha256, sha(zipBytes))
  assert.equal(receipt.zip.bytes, zipBytes.length)
  assert.equal(receipt.executableSha256, sha(executableBytes))
  assert.equal(receipt.asarSha256, sha(x64Bytes))
  assert.equal(receipt.bootstrapSha256, sha(bootstrapBytes))
  assert.equal(receipt.native, undefined)
  assert.equal(EXTRACT_TIMEOUT_MS > 15_000, true)
})

test('refuses a different source, zip, or translated architecture before launch', async () => {
  const receipt = await universalTransferReceipt(await dist(), version, source)
  await assert.rejects(
    async () => assertZipPin(receipt, observed(receipt, { sourceHead: 'b'.repeat(40) })),
    /Source differs/,
  )
  await assert.rejects(
    async () => assertZipPin(receipt, observed(receipt, { zipSha256: 'a'.repeat(64) })),
    /ZIP hash mismatch/,
  )
  await assert.rejects(
    async () => assertZipPin(receipt, observed(receipt, { zipBytes: receipt.zip.bytes + 1 })),
    /ZIP size mismatch/,
  )
  await assert.rejects(
    async () => assertZipPin(receipt, observed(receipt, { arch: 'arm64' })),
    /non-x64/,
  )
  await assert.rejects(
    async () => assertZipPin(receipt, observed(receipt, { hostArch: 'arm64' })),
    /translated or foreign/,
  )
  await assert.rejects(
    async () => assertZipPin({ ...receipt, nativeExecuted: true }, observed(receipt)),
    /cannot claim native execution/,
  )
  await assert.rejects(
    async () =>
      assertBundlePin(receipt, observed(receipt, { executableSha256: sha(Buffer.from('other')) })),
    /Executable hash mismatch/,
  )
})

test('functional plan stays withheld unless the isolated x64 import passed', async () => {
  const receipt = await universalTransferReceipt(await dist(), version, source)
  const pin = assertBundlePin(receipt, observed(receipt))
  const layout = {
    executable: 'E:/app/Ari.app/Contents/MacOS/ari',
    resources: 'E:/app/Ari.app/Contents/Resources',
    archive: 'E:/app/Ari.app/Contents/Resources/app-x64.asar',
    dataRoot: 'E:/runner/ari-macos-intel-diagnostic',
    fixture: 'E:/repo/fixture.json',
  }
  assert.equal(x64DiagnosticPlan(pin, layout).functional, null)
  assert.equal(
    x64DiagnosticPlan(pin, layout, { ...nativeOk, physicalBehaviorTested: true }).functional,
    null,
  )
  assert.equal(x64DiagnosticPlan({ ...pin, isolated: false }, layout, nativeOk).functional, null)
  const plan = x64DiagnosticPlan(pin, layout, nativeOk)
  assert.equal(plan.native.arch, 'x64')
  assert.equal(plan.functional.arch, 'x64')
  assert.equal(plan.functional.archive.endsWith('app-x64.asar'), true)
  assert.equal(JSON.stringify(plan).includes('arm64'), false)
})

test('diagnosis extracts only after the zip pin and runs functional smoke only after x64 import', async () => {
  const root = await dist()
  const receipt = await universalTransferReceipt(root, version, source)
  const calls = []
  const dependencies = {
    extract: async (_zip, dest) => {
      calls.push('extract')
      const resources = join(dest, 'Ari.app/Contents/Resources')
      await mkdir(join(dest, 'Ari.app/Contents/MacOS'), { recursive: true })
      await mkdir(resources, { recursive: true })
      await writeFile(join(dest, 'Ari.app/Contents/MacOS/ari'), executableBytes)
      await writeFile(join(resources, 'app.asar'), bootstrapBytes)
      await writeFile(join(resources, 'app-x64.asar'), x64Bytes)
    },
    sha256: async (path) => sha(await readFile(path)),
    nativeSmoke: async (plan) => {
      calls.push(['native', plan.arch])
      return nativeOk
    },
    functionalSmoke: async (plan) => {
      calls.push(['functional', plan.arch, plan.archive.endsWith('app-x64.asar')])
      return { passed: true, suiteRoot: 'suite' }
    },
  }
  const input = {
    receipt,
    ...observed(receipt),
    zipPath: join(root, receipt.zip.name),
    extractRoot: join(root, 'extract'),
    dataRoot: join(root, 'evidence'),
    fixture: join(root, 'fixture.json'),
  }
  const result = await diagnoseTransferred(input, dependencies)
  assert.equal(result.functional.passed, true)
  assert.deepEqual(calls, ['extract', ['native', 'x64'], ['functional', 'x64', true]])

  calls.length = 0
  dependencies.nativeSmoke = async () => {
    calls.push('native-fail')
    throw new Error('probe timeout')
  }
  await assert.rejects(diagnoseTransferred(input, dependencies), /probe timeout/)
  assert.deepEqual(calls, ['extract', 'native-fail'])

  calls.length = 0
  await assert.rejects(
    diagnoseTransferred({ ...input, zipSha256: 'c'.repeat(64) }, dependencies),
    /ZIP hash mismatch/,
  )
  assert.deepEqual(calls, [])
  await assert.rejects(
    diagnoseTransferred({ ...input, isolated: false }, dependencies),
    /hosted isolation/,
  )
  assert.deepEqual(calls, [])
})

test('locate accepts one top-level app and refuses a missing or duplicate executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ari-intel-layout-'))
  await mkdir(join(root, 'Ari.app/Contents/MacOS'), { recursive: true })
  await writeFile(join(root, 'Ari.app/Contents/MacOS/ari'), executableBytes)
  assert.equal(
    (await locateUniversalExecutable(root)).endsWith(
      `${join('Ari.app', 'Contents', 'MacOS', 'ari')}`,
    ),
    true,
  )
  await mkdir(join(root, 'Other.app/Contents/MacOS'), { recursive: true })
  await writeFile(join(root, 'Other.app/Contents/MacOS/ari'), executableBytes)
  await assert.rejects(locateUniversalExecutable(root), /one universal/)
})

test('hosted guard and this Windows process refuse diagnosis before ditto', async () => {
  const absolute = join(tmpdir(), 'runner')
  assert.equal(hostedIsolation({}), false)
  assert.equal(
    hostedIsolation({
      RELEASE_FUNCTIONAL_CI: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_TEMP: absolute,
    }),
    true,
  )
  await assert.rejects(async () => assertHostedDiagnosis({ CI: 'true' }), /hosted isolation/)
  await assert.rejects(
    async () =>
      runDiagnosis({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_TEMP: absolute,
        RELEASE_FUNCTIONAL_CI: '1',
        CANDIDATE_SHA: source,
      }),
    /Intel macOS runner|non-x64/,
  )
})

test('workflow runs the Intel diagnostic after package failure without a publisher or continue-on-error pass', async () => {
  const workflowDir = join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows')
  const workflow = await readFile(join(workflowDir, 'release-candidate.yml'), 'utf8')
  const release = await readFile(join(workflowDir, 'release.yml'), 'utf8')
  assert.equal(workflow.includes('continue-on-error'), false)
  assert.match(workflow, /os: macos-latest\r?\n\s+args: --mac/)
  assert.match(workflow, /node scripts\/release-macos-preflight\.mjs/)
  assert.match(workflow, /node scripts\/release-macos-intel-diagnostic\.mjs receipt/)
  assert.match(workflow, /steps\.package-binary\.outcome == 'success'/)
  assert.match(workflow, /runs-on: macos-26-intel/)
  assert.match(
    workflow,
    /needs: package\r?\n\s+if: always\(\) && !cancelled\(\) && needs\.package\.result == 'failure'/,
  )
  assert.match(
    workflow,
    /name: ari-candidate-\$\{\{ matrix\.os \}\}-\$\{\{ env\.CANDIDATE_SHA \}\}/,
  )
  assert.match(workflow, new RegExp(`dist/${TRANSFER_NAME}`))
  assert.match(workflow, /name: ari-macos-intel-x64-\$\{\{ env\.CANDIDATE_SHA \}\}/)
  assert.equal(workflow.includes('needs: macos-intel-x64'), false)
  assert.match(release, /needs: \[identify, package\]/)
  assert.match(release, /pattern: ari-candidate-\*-\$\{\{ env\.CANDIDATE_SHA \}\}/)
  assert.match(release, /pattern: ari-functional-\*-\$\{\{ env\.CANDIDATE_SHA \}\}/)
  assert.match(release, /pattern: ari-install-\*-\$\{\{ env\.CANDIDATE_SHA \}\}/)
  assert.equal(release.includes('macos-26-intel'), false)
  assert.equal(release.includes('ari-macos-intel-x64'), false)
})
