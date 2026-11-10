// Pins the already-built universal ZIP for one native macos-26-intel x64 run.
// Hashing only on the package job. No second build, arm64 loop, or gate waiver.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { verifyArtifacts } from './release-artifacts.mjs'
import { smoke as functionalSmoke } from './release-functional-smoke.mjs'
import { archivePath, sha256, smoke as nativeSmoke } from './release-native-smoke.mjs'

export const TRANSFER_NAME = 'macos-intel-transfer.json'
export const INTEL_RUNNER = 'macos-26-intel'
export const EVIDENCE_DIR = 'ari-macos-intel-diagnostic'
// Unpack budget for the universal ZIP. The x64 probe keeps release-native-smoke's 15s.
export const EXTRACT_TIMEOUT_MS = 120_000

const run = promisify(execFile)

export function hostedIsolation(env = process.env) {
  return Boolean(
    env.RELEASE_FUNCTIONAL_CI === '1' &&
    env.CI === 'true' &&
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    isAbsolute(env.RUNNER_TEMP ?? ''),
  )
}

export function assertHostedDiagnosis(env = process.env) {
  assert.equal(hostedIsolation(env), true, 'Intel diagnosis requires hosted isolation')
}

export async function universalTransferReceipt(root, version, sourceHead) {
  assert.equal(version, '0.3.13', 'This transfer is scoped to candidate 0.3.13')
  assert.match(sourceHead ?? '', /^[a-f0-9]{40}$/i, 'Exact candidate SHA is required')
  const verified = await verifyArtifacts(root, 'darwin', version)
  const zip = verified.files.find((file) => file.name === `Ari-${version}-universal.zip`)
  assert.ok(zip, 'Universal ZIP missing from verifyArtifacts')
  const contents = join(root, 'mac-universal/ari.app/Contents')
  const executable = join(contents, 'MacOS/ari')
  const resources = join(contents, 'Resources')
  const info = await lstat(executable)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Universal executable is not a regular file')
  const archive = archivePath(resources, 'x64')
  return {
    kind: 'macos-universal-transfer',
    sourceHead: sourceHead.toLowerCase(),
    version,
    platform: 'darwin',
    arch: 'x64',
    nativeExecuted: false,
    zip,
    archiveName: archive.endsWith('app-x64.asar') ? 'app-x64.asar' : 'app.asar',
    executableSha256: await sha256(executable),
    asarSha256: await sha256(archive),
    bootstrapSha256: await sha256(join(resources, 'app.asar')),
  }
}

export function assertZipPin(receipt, observed) {
  assert.equal(receipt?.kind, 'macos-universal-transfer')
  assert.equal(receipt.nativeExecuted, false, 'Transfer receipt cannot claim native execution')
  assert.equal(receipt.version, '0.3.13')
  assert.equal(receipt.platform, 'darwin')
  assert.equal(receipt.arch, 'x64')
  assert.equal(receipt.zip?.name, 'Ari-0.3.13-universal.zip')
  assert.match(receipt.archiveName ?? '', /^app(-x64)?\.asar$/)
  assert.match(receipt.sourceHead ?? '', /^[a-f0-9]{40}$/)
  assert.match(observed.sourceHead ?? '', /^[a-f0-9]{40}$/i, 'Exact candidate SHA is required')
  assert.equal(
    observed.sourceHead.toLowerCase(),
    receipt.sourceHead,
    'Source differs from the packaged candidate',
  )
  assert.equal(observed.platform, 'darwin', 'Intel diagnostic is macOS-only')
  assert.equal(observed.arch, 'x64', 'Refusing a non-x64 execution')
  assert.equal(observed.hostArch, 'x64', 'Refusing translated or foreign host architecture')
  assert.equal(observed.zipSha256, receipt.zip.sha256, 'Universal ZIP hash mismatch')
  assert.equal(observed.zipBytes, receipt.zip.bytes, 'Universal ZIP size mismatch')
}

export function assertBundlePin(receipt, observed) {
  assertZipPin(receipt, observed)
  assert.equal(observed.executableSha256, receipt.executableSha256, 'Executable hash mismatch')
  assert.equal(observed.asarSha256, receipt.asarSha256, 'x64 archive hash mismatch')
  assert.equal(observed.bootstrapSha256, receipt.bootstrapSha256, 'Bootstrap archive hash mismatch')
  return {
    sourceHead: receipt.sourceHead,
    version: receipt.version,
    arch: 'x64',
    platform: 'darwin',
    hostArch: 'x64',
    executableSha256: receipt.executableSha256,
    asarSha256: receipt.asarSha256,
    bootstrapSha256: receipt.bootstrapSha256,
    isolated: observed.isolated === true,
  }
}

export function x64DiagnosticPlan(pin, layout, nativeResult = null) {
  assert.equal(pin.arch, 'x64')
  assert.equal(pin.hostArch, 'x64')
  const native = {
    executable: layout.executable,
    resources: layout.resources,
    arch: 'x64',
    executableSha256: pin.executableSha256,
    asarSha256: pin.asarSha256,
    dataRoot: layout.dataRoot,
  }
  const nativeOk =
    nativeResult?.kind === 'packaged-native-module-load' &&
    nativeResult.arch === 'x64' &&
    nativeResult.platform === 'darwin' &&
    nativeResult.version === pin.version &&
    nativeResult.physicalBehaviorTested === false &&
    Boolean(nativeResult.electron)
  if (!nativeOk || pin.isolated !== true) return { native, functional: null }
  return {
    native,
    functional: {
      sourceHead: pin.sourceHead,
      version: pin.version,
      arch: 'x64',
      executable: layout.executable,
      resources: layout.resources,
      archive: layout.archive,
      executableSha256: pin.executableSha256,
      asarSha256: pin.asarSha256,
      bootstrapSha256: pin.bootstrapSha256,
      fixture: layout.fixture,
      dataRoot: layout.dataRoot,
    },
  }
}

// electron-builder's mac zip has one top-level .app. Do not search the tree.
export async function locateUniversalExecutable(root) {
  const entries = await readdir(root, { withFileTypes: true })
  assert.ok(entries.length < 100, 'Unexpected universal ZIP layout')
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.endsWith('.app')) continue
    const executable = join(root, entry.name, 'Contents/MacOS/ari')
    let info
    try {
      info = await lstat(executable)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (info.isFile() && !info.isSymbolicLink()) found.push(executable)
  }
  assert.equal(found.length, 1, 'Expected one universal app executable')
  return found[0]
}

export async function diagnoseTransferred(input, dependencies) {
  assert.equal(input.isolated, true, 'Refusing diagnosis outside hosted isolation')
  assertZipPin(input.receipt, input)
  await dependencies.extract(input.zipPath, input.extractRoot)
  const executable = await locateUniversalExecutable(input.extractRoot)
  const resources = join(dirname(dirname(executable)), 'Resources')
  const archive = join(resources, input.receipt.archiveName)
  const observed = {
    ...input,
    executableSha256: await dependencies.sha256(executable),
    asarSha256: await dependencies.sha256(archive),
    bootstrapSha256: await dependencies.sha256(join(resources, 'app.asar')),
  }
  const pin = assertBundlePin(input.receipt, observed)
  const layout = {
    executable,
    resources,
    archive,
    dataRoot: input.dataRoot,
    fixture: input.fixture,
  }
  const native = await dependencies.nativeSmoke(x64DiagnosticPlan(pin, layout).native)
  assert.equal(native.version, pin.version, 'Packaged native probe version mismatch')
  const plan = x64DiagnosticPlan(pin, layout, native)
  assert.ok(plan.functional, 'Successful isolated x64 import must run functional smoke')
  assert.equal(plan.functional.arch, 'x64')
  const functional = await dependencies.functionalSmoke(plan.functional)
  assert.equal(functional?.passed, true, 'Functional smoke did not pass')
  return { native, functional }
}

async function sourceHead(env) {
  const head = (await run('git', ['rev-parse', 'HEAD'], { windowsHide: true })).stdout.trim()
  assert.equal(head, env.CANDIDATE_SHA, 'Checkout differs from exact candidate')
  return head
}

export async function writeReceipt(root = resolve('dist'), env = process.env) {
  const version = JSON.parse(await readFile(resolve('apps/desktop/package.json'), 'utf8')).version
  const receipt = await universalTransferReceipt(root, version, await sourceHead(env))
  await writeFile(join(root, TRANSFER_NAME), `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

async function extractZip(zipPath, dest) {
  await mkdir(dest, { recursive: true })
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, dest], {
    cwd: dest,
    windowsHide: true,
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  })
}

export async function runDiagnosis(env = process.env) {
  assertHostedDiagnosis(env)
  assert.equal(process.platform, 'darwin', 'This diagnosis runs on the Intel macOS runner')
  assert.equal(process.arch, 'x64', 'Refusing a non-x64 runner')
  const head = await sourceHead(env)
  const root = resolve('dist')
  const receipt = JSON.parse(await readFile(join(root, TRANSFER_NAME), 'utf8'))
  const zipPath = join(root, receipt.zip.name)
  const info = await lstat(zipPath)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Transferred ZIP is not a regular file')
  const runner = await realpath(env.RUNNER_TEMP)
  const extractRoot = await mkdtemp(join(runner, 'ari-macos-intel-extract-'))
  const evidenceRoot = join(runner, EVIDENCE_DIR)
  await mkdir(evidenceRoot, { recursive: true })
  const dataRoot = await mkdtemp(join(evidenceRoot, 'intel-'))
  const record = {
    kind: 'macos-intel-diagnostic',
    sourceHead: head,
    runner: INTEL_RUNNER,
    platform: process.platform,
    arch: process.arch,
    image: env.ImageOS ?? null,
    imageVersion: env.ImageVersion ?? null,
    native: null,
    functional: null,
  }
  try {
    const result = await diagnoseTransferred(
      {
        receipt,
        sourceHead: head,
        platform: process.platform,
        arch: process.arch,
        hostArch: process.arch,
        zipSha256: await sha256(zipPath),
        zipBytes: info.size,
        zipPath,
        extractRoot,
        isolated: true,
        dataRoot,
        fixture: resolve('apps/desktop/src/main/testing/release-profile-0312.fixture.json'),
      },
      {
        extract: extractZip,
        nativeSmoke: async (plan) => {
          const native = await nativeSmoke(plan)
          record.native = native // Preserve a real import pass if renderer smoke later fails.
          return native
        },
        functionalSmoke,
        sha256,
      },
    )
    record.native = result.native
    record.functional = { passed: true, suiteRoot: result.functional.suiteRoot }
    return record
  } catch (error) {
    record.error = String(error).slice(0, 4000)
    throw error
  } finally {
    await writeFile(join(dataRoot, 'diagnostic.json'), `${JSON.stringify(record, null, 2)}\n`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2]
  assert.equal(process.argv.length, 3, 'Use receipt or diagnose')
  const action = command === 'receipt' ? writeReceipt : command === 'diagnose' ? runDiagnosis : null
  assert.ok(action, 'Use receipt or diagnose')
  action().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
}
