// Converts the exact successful package/native receipt into guarded GUI plans.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { smoke } from './release-functional-smoke.mjs'
import { requireHostedCI, sha256 } from './release-functional-support.mjs'

export function functionalPlans(receipt, context) {
  assert.equal(receipt.sourceHead, context.sourceHead, 'Package receipt differs from checkout')
  assert.equal(receipt.version, '0.3.13', 'Unexpected package version')
  assert.equal(receipt.platform, context.platform, 'Wrong artifact platform')
  assert.ok(!receipt.nativeFailure, 'Native package gate did not pass')
  const arches = context.platform === 'darwin' ? ['arm64', 'x64'] : ['x64']
  assert.deepEqual(
    receipt.native.map((entry) => entry.arch).sort(),
    [...arches].sort(),
    'Every supported native slice must pass before functional launch',
  )
  return arches.map((arch) => {
    const entry = receipt.native.find((entry) => entry.arch === arch)
    assert.equal(entry.kind, 'packaged-native-module-load')
    assert.equal(entry.platform, context.platform)
    assert.equal(entry.version, receipt.version)
    assert.ok(entry.electron, 'Native receipt is not packaged Electron')
    assert.equal(entry.physicalBehaviorTested, false)
    const archive = join(
      context.resources,
      entry.archive.endsWith(`app-${arch}.asar`) ? `app-${arch}.asar` : 'app.asar',
    )
    assert.equal(entry.archive, archive, 'Native receipt archive differs from packaged output')
    for (const hash of [entry.executableSha256, entry.asarSha256, context.bootstrapSha256])
      assert.match(hash ?? '', /^[a-f0-9]{64}$/i, 'Missing exact artifact hash')
    return {
      sourceHead: context.sourceHead,
      version: receipt.version,
      arch,
      executable: context.executable,
      resources: context.resources,
      archive,
      executableSha256: entry.executableSha256,
      asarSha256: entry.asarSha256,
      bootstrapSha256: context.bootstrapSha256,
      fixture: context.fixture,
      dataRoot: context.dataRoot,
    }
  })
}

async function main() {
  requireHostedCI()
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
  assert.equal(sourceHead, process.env.CANDIDATE_SHA, 'Checkout differs from candidate')
  const root = resolve('dist')
  const app = process.platform === 'darwin' ? join(root, 'mac-universal/ari.app/Contents') : null
  const output = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'
  const resources = app ? join(app, 'Resources') : join(root, output, 'resources')
  const executable = app
    ? join(app, 'MacOS/ari')
    : join(root, output, process.platform === 'win32' ? 'ari.exe' : 'ari')
  const dataRoot = resolve(process.env.RUNNER_TEMP, 'ari-release-functional')
  await mkdir(dataRoot, { recursive: true })
  const receipt = JSON.parse(await readFile(join(root, 'candidate-artifacts.json'), 'utf8'))
  const plans = functionalPlans(receipt, {
    sourceHead,
    platform: process.platform,
    resources,
    executable,
    dataRoot,
    fixture: resolve('apps/desktop/src/main/testing/release-profile-0312.fixture.json'),
    bootstrapSha256: await sha256(join(resources, 'app.asar')),
  })
  for (const plan of plans) {
    await writeFile(join(dataRoot, `plan-${plan.arch}.json`), JSON.stringify(plan, null, 2) + '\n')
    const result = await smoke(plan)
    assert.equal(result.passed, true)
    console.log(
      JSON.stringify({ sourceHead, arch: plan.arch, suiteRoot: result.suiteRoot, passed: true }),
    )
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch((error) => {
    console.error(String(error))
    process.exitCode = 1
  })
