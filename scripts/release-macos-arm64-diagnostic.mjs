// Evidence only after a failed translated preflight. Never waives that failure.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { archivePath, sha256, smoke } from './release-native-smoke.mjs'

export const EVIDENCE_DIR = 'ari-macos-arm64-diagnostic'

export function assertHostedArm64(
  env = process.env,
  platform = process.platform,
  arch = process.arch,
) {
  assert.ok(
    env.RELEASE_FUNCTIONAL_CI === '1' &&
      env.CI === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted' &&
      isAbsolute(env.RUNNER_TEMP ?? ''),
    'ARM64 diagnosis requires disposable hosted isolation',
  )
  assert.equal(platform, 'darwin', 'ARM64 diagnosis requires macOS')
  assert.equal(arch, 'arm64', 'ARM64 diagnosis requires a native ARM64 host')
  assert.match(env.CANDIDATE_SHA ?? '', /^[a-f0-9]{40}$/, 'Exact candidate SHA required')
}

export async function pinnedPlan(dist, sourceHead) {
  assert.ok(isAbsolute(dist), 'Use an absolute package directory')
  assert.match(sourceHead ?? '', /^[a-f0-9]{40}$/)
  const receipt = JSON.parse(await readFile(join(dist, 'macos-intel-transfer.json'), 'utf8'))
  assert.equal(receipt.kind, 'macos-universal-transfer')
  assert.equal(receipt.sourceHead, sourceHead, 'Transfer source differs from candidate')
  assert.equal(receipt.version, '0.3.14')
  assert.equal(receipt.platform, 'darwin')
  assert.equal(receipt.arch, 'x64')
  assert.equal(receipt.nativeExecuted, false, 'A transfer receipt is not native proof')
  assert.equal(receipt.zip?.name, 'Ari-0.3.14-universal.zip')
  // This release's universal package uses a shared ASAR. Do not reuse x64 pins
  // for a split ARM64 archive if a future build changes the packaging layout.
  assert.equal(receipt.archiveName, 'app.asar', 'Split ARM64 archives need their own transfer pin')
  for (const hash of [
    receipt.zip.sha256,
    receipt.executableSha256,
    receipt.asarSha256,
    receipt.bootstrapSha256,
  ])
    assert.match(hash ?? '', /^[a-f0-9]{64}$/)
  const contents = join(dist, 'mac-universal/ari.app/Contents')
  const executable = join(contents, 'MacOS/ari')
  const resources = join(contents, 'Resources')
  const archive = archivePath(resources, 'arm64')
  assert.equal(archive, join(resources, 'app.asar'), 'Unpinned split ARM64 archive')
  const zip = join(dist, receipt.zip.name)
  for (const path of [zip, executable, archive]) {
    const info = await lstat(path)
    assert.ok(
      info.isFile() && !info.isSymbolicLink(),
      'Pinned package input must be a regular file',
    )
  }
  assert.equal((await lstat(zip)).size, receipt.zip.bytes, 'Universal ZIP size mismatch')
  assert.equal(await sha256(zip), receipt.zip.sha256, 'Universal ZIP hash mismatch')
  assert.equal(await sha256(executable), receipt.executableSha256, 'Executable hash mismatch')
  assert.equal(await sha256(archive), receipt.asarSha256, 'ARM64 archive hash mismatch')
  assert.equal(
    receipt.asarSha256,
    receipt.bootstrapSha256,
    'Shared bootstrap archive hash mismatch',
  )
  return {
    sourceHead,
    executable,
    resources,
    arch: 'arm64',
    executableSha256: receipt.executableSha256,
    asarSha256: receipt.asarSha256,
    bootstrapSha256: receipt.bootstrapSha256,
    zip: receipt.zip,
  }
}

export async function recordDiagnosis(plan, dataRoot, nativeSmoke = smoke) {
  assert.ok(isAbsolute(dataRoot), 'Use absolute disposable evidence root')
  assert.equal(plan.arch, 'arm64')
  await mkdir(dataRoot, { recursive: true })
  const record = {
    kind: 'macos-arm64-diagnostic',
    sourceHead: plan.sourceHead,
    arch: plan.arch,
    executableSha256: plan.executableSha256,
    asarSha256: plan.asarSha256,
    bootstrapSha256: plan.bootstrapSha256,
    zip: plan.zip,
    diagnosticOnly: true,
    translatedGateWaived: false,
    native: null,
    error: null,
  }
  try {
    const native = await nativeSmoke({ ...plan, dataRoot })
    assert.equal(native.kind, 'packaged-native-module-load')
    assert.equal(native.arch, 'arm64')
    assert.equal(native.platform, 'darwin')
    assert.equal(native.version, '0.3.14')
    assert.ok(native.electron, 'Packaged Electron entry is required')
    assert.equal(native.physicalBehaviorTested, false)
    assert.equal(native.executableSha256, plan.executableSha256)
    assert.equal(native.asarSha256, plan.asarSha256)
    record.native = native
    return record
  } catch (error) {
    record.error = String(error).slice(0, 6000)
    throw error
  } finally {
    await writeFile(join(dataRoot, 'diagnostic.json'), `${JSON.stringify(record, null, 2)}\n`, {
      flag: 'wx',
    })
  }
}

async function main() {
  assertHostedArm64()
  const head = (
    await promisify(execFile)('git', ['rev-parse', 'HEAD'], { windowsHide: true })
  ).stdout.trim()
  assert.equal(head, process.env.CANDIDATE_SHA, 'Checkout differs from exact candidate')
  const plan = await pinnedPlan(resolve('dist'), head)
  const evidence = join(process.env.RUNNER_TEMP, EVIDENCE_DIR)
  await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, 'arm64-'))
  console.log(JSON.stringify(await recordDiagnosis(plan, root), null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
