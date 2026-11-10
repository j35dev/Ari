import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertHostedArm64,
  pinnedPlan,
  recordDiagnosis,
} from './release-macos-arm64-diagnostic.mjs'
import { sha256 } from './release-native-smoke.mjs'

const head = 'b'.repeat(40)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ari-arm64-pin-test-'))
  const dist = join(root, 'dist')
  const contents = join(dist, 'mac-universal/ari.app/Contents')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await mkdir(join(contents, 'Resources'), { recursive: true })
  const zip = join(dist, 'Ari-0.3.13-universal.zip')
  const executable = join(contents, 'MacOS/ari')
  const archive = join(contents, 'Resources/app.asar')
  await writeFile(zip, 'synthetic zip; never extracted')
  await writeFile(executable, 'synthetic executable; never launched')
  await writeFile(archive, 'synthetic shared archive')
  const receipt = {
    kind: 'macos-universal-transfer',
    sourceHead: head,
    version: '0.3.13',
    platform: 'darwin',
    arch: 'x64',
    nativeExecuted: false,
    zip: { name: 'Ari-0.3.13-universal.zip', bytes: 30, sha256: await sha256(zip) },
    archiveName: 'app.asar',
    executableSha256: await sha256(executable),
    asarSha256: await sha256(archive),
    bootstrapSha256: await sha256(archive),
  }
  receipt.zip.bytes = (await readFile(zip)).length
  const receiptPath = join(dist, 'macos-intel-transfer.json')
  await writeFile(receiptPath, JSON.stringify(receipt))
  return { root, dist, executable, archive, zip, receipt, receiptPath }
}

test('rejects local, Intel and foreign-host launches before package selection', () => {
  const env = {
    RELEASE_FUNCTIONAL_CI: '1',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_TEMP: tmpdir(),
    CANDIDATE_SHA: head,
  }
  assertHostedArm64(env, 'darwin', 'arm64')
  assert.throws(() => assertHostedArm64({ ...env, CI: '' }, 'darwin', 'arm64'), /hosted isolation/)
  assert.throws(() => assertHostedArm64(env, 'win32', 'arm64'), /macOS/)
  assert.throws(() => assertHostedArm64(env, 'darwin', 'x64'), /native ARM64/)
  assert.throws(
    () => assertHostedArm64({ ...env, CANDIDATE_SHA: 'main' }, 'darwin', 'arm64'),
    /Exact candidate/,
  )
})

test('same-artifact plan pins source, ZIP, executable and shared ARM64 archive', async () => {
  const f = await fixture()
  const plan = await pinnedPlan(f.dist, head)
  assert.equal(plan.arch, 'arm64')
  assert.equal(plan.executable, f.executable)
  assert.equal(plan.asarSha256, f.receipt.asarSha256)
  assert.equal(plan.bootstrapSha256, plan.asarSha256)
  await assert.rejects(pinnedPlan(f.dist, 'c'.repeat(40)), /Transfer source/)
})

test('rejects changed ZIP even at the same length', async () => {
  const f = await fixture()
  await writeFile(f.zip, Buffer.alloc(f.receipt.zip.bytes))
  await assert.rejects(pinnedPlan(f.dist, head), /ZIP hash/)
})

test('rejects executable and archive replacement before invoking a probe', async () => {
  const f = await fixture()
  await writeFile(f.executable, 'changed executable')
  await assert.rejects(pinnedPlan(f.dist, head), /Executable hash/)
  const other = await fixture()
  await writeFile(other.archive, 'changed shared archive')
  await assert.rejects(pinnedPlan(other.dist, head), /ARM64 archive hash/)
})

test('rejects split ARM64 archives without an independent ARM64 transfer pin', async () => {
  const f = await fixture()
  await writeFile(
    join(f.dist, 'mac-universal/ari.app/Contents/Resources/app-arm64.asar'),
    'unpinned',
  )
  await assert.rejects(pinnedPlan(f.dist, head), /Unpinned split/)
})

test('successful ARM64 evidence cannot waive the failed translated gate', async () => {
  const f = await fixture()
  const plan = await pinnedPlan(f.dist, head)
  const record = await recordDiagnosis(plan, join(f.root, 'evidence'), async (options) => {
    assert.equal(options.arch, 'arm64')
    return {
      kind: 'packaged-native-module-load',
      version: '0.3.13',
      electron: '43.4.1',
      platform: 'darwin',
      arch: 'arm64',
      physicalBehaviorTested: false,
      executableSha256: options.executableSha256,
      asarSha256: options.asarSha256,
    }
  })
  assert.equal(record.diagnosticOnly, true)
  assert.equal(record.translatedGateWaived, false)
  assert.equal(record.native.arch, 'arm64')
  assert.equal(
    JSON.parse(await readFile(join(f.root, 'evidence/diagnostic.json'), 'utf8')).error,
    null,
  )
})

test('preserves probe timeout as failure with no native success or retry', async () => {
  const f = await fixture()
  const plan = await pinnedPlan(f.dist, head)
  let calls = 0
  await assert.rejects(
    recordDiagnosis(plan, join(f.root, 'evidence'), async () => {
      calls++
      throw new Error('packaged-native-probe-failed: SIGTERM at 15000ms')
    }),
    /SIGTERM/,
  )
  assert.equal(calls, 1)
  const receipt = JSON.parse(await readFile(join(f.root, 'evidence/diagnostic.json'), 'utf8'))
  assert.equal(receipt.native, null)
  assert.match(receipt.error, /SIGTERM/)
  assert.equal(receipt.translatedGateWaived, false)
})

test('workflow runs diagnostic after failure without changing native budgets or proof artifacts', async () => {
  const workflow = await readFile('.github/workflows/release-candidate.yml', 'utf8')
  const step = workflow
    .split('- name: Record native ARM64 entry after translated failure')[1]
    ?.split('- name:')[0]
  assert.ok(step)
  assert.match(step, /always\(\).*steps\.translated-preflight\.outcome == 'failure'/)
  assert.match(step, /steps\.universal-transfer\.outcome == 'success'/)
  assert.doesNotMatch(step, /continue-on-error/)
  assert.match(workflow, /name: ari-macos-arm64-diagnostic-/)
  const nativeSource = await readFile('scripts/release-native-smoke.mjs', 'utf8')
  assert.match(nativeSource, /timeout: 15_000/)
})
